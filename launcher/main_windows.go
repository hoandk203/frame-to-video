//go:build windows

package main

import (
    "context"
    "crypto/rand"
    "crypto/sha256"
    "encoding/binary"
    "encoding/hex"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "net"
    "os"
    "path/filepath"
    "sort"
    "strings"
    "sync"
    "time"
    "unsafe"

    winio "github.com/Microsoft/go-winio"
    "golang.org/x/sys/windows"
)

type config struct { SchemaVersion int `json:"schemaVersion"`; Port int `json:"port"`; DataDir string `json:"dataDir"` }
type message struct {
    RequestID string `json:"requestId,omitempty"`; Action string `json:"action,omitempty"`; Nonce string `json:"nonce,omitempty"`; PID uint32 `json:"pid,omitempty"`
    URL string `json:"url,omitempty"`; Error string `json:"error,omitempty"`; JobID string `json:"jobId,omitempty"`
    Active bool `json:"active,omitempty"`; CancelActiveJob bool `json:"cancelActiveJob,omitempty"`
}
var user32 = windows.NewLazySystemDLL("user32.dll")
var messageBox = user32.NewProc("MessageBoxW")
var shell32 = windows.NewLazySystemDLL("shell32.dll")
var shellExecute = shell32.NewProc("ShellExecuteW")

func text(s string) *uint16 { p, _ := windows.UTF16PtrFromString(s); return p }
func dialog(s string, confirm bool) bool {
    flags := uintptr(0x10)
    if confirm { flags = 0x04 | 0x30 }
    result, _, _ := messageBox.Call(0, uintptr(unsafe.Pointer(text(s))), uintptr(unsafe.Pointer(text("Frame to Video Studio"))), flags)
    return result == 6
}
func openBrowser(url string) error {
    result, _, _ := shellExecute.Call(0, uintptr(unsafe.Pointer(text("open"))), uintptr(unsafe.Pointer(text(url))), 0, 0, 1)
    if result <= 32 { return fmt.Errorf("Không mở được trình duyệt. Mở URL thủ công: %s", url) }
    return nil
}
func readMessage(conn net.Conn) (message, error) {
    var header [4]byte
    if _, err := io.ReadFull(conn, header[:]); err != nil { return message{}, err }
    length := binary.LittleEndian.Uint32(header[:])
    if length == 0 || length > 65536 { return message{}, errors.New("Invalid control message size") }
    body := make([]byte, length)
    if _, err := io.ReadFull(conn, body); err != nil { return message{}, err }
    var m message
    err := json.Unmarshal(body, &m)
    return m, err
}
func writeMessage(conn net.Conn, m message) error {
    b, err := json.Marshal(m); if err != nil { return err }
    if len(b) > 65536 { return errors.New("Control message too large") }
    var header [4]byte; binary.LittleEndian.PutUint32(header[:], uint32(len(b)))
    _, err = io.Copy(conn, io.MultiReader(strings.NewReader(string(header[:])), strings.NewReader(string(b))))
    return err
}
func envBlock(extra map[string]string) ([]uint16, error) {
    values := map[string]string{}
    for _, item := range os.Environ() { key, value, ok := strings.Cut(item, "="); if ok && key != "" { values[strings.ToUpper(key)] = value } }
    // Do not inherit developer overrides or Node injection flags into portable runtime.
    for _, key := range []string{"NODE_OPTIONS", "NODE_PATH", "APP_DEV", "DATA_DIR", "PORT", "FFMPEG_PATH", "FFPROBE_PATH"} { delete(values, key) }
    for key, value := range extra { values[key] = value }
    keys := make([]string, 0, len(values)); for key := range values { keys = append(keys, key) }; sort.Strings(keys)
    var block []uint16
    for _, key := range keys { s, err := windows.UTF16FromString(key+"="+values[key]); if err != nil { return nil, err }; block = append(block, s...) }
    return append(block, 0), nil
}
func startBackend(root, data, pipe, nonce string, job windows.Handle) (windows.ProcessInformation, error) {
    var pi windows.ProcessInformation
    app := filepath.Join(root, "runtime", "node.exe")
    entry := filepath.Join(root, "app", "server", "main.js")
    command, err := windows.UTF16FromString(windows.ComposeCommandLine([]string{app, entry})); if err != nil { return pi, err }
    env, err := envBlock(map[string]string{"APP_ROOT":root, "DATA_DIR":data, "WEB_ROOT":filepath.Join(root,"app","web"), "FTVS_CONTROL_PIPE":pipe, "FTVS_STARTUP_NONCE":nonce}); if err != nil { return pi, err }
    var si windows.StartupInfo; si.Cb = uint32(unsafe.Sizeof(si))
    err = windows.CreateProcess(text(app), &command[0], nil, nil, false,
        windows.CREATE_SUSPENDED | windows.CREATE_NO_WINDOW | windows.CREATE_UNICODE_ENVIRONMENT,
        &env[0], text(root), &si, &pi)
    if err != nil { return pi, err }
    if err = windows.AssignProcessToJobObject(job, pi.Process); err != nil { windows.TerminateProcess(pi.Process,1); windows.CloseHandle(pi.Thread); windows.CloseHandle(pi.Process); return windows.ProcessInformation{}, err }
    if _, err = windows.ResumeThread(pi.Thread); err != nil { windows.TerminateProcess(pi.Process,1); windows.CloseHandle(pi.Thread); windows.CloseHandle(pi.Process); return windows.ProcessInformation{}, err }
    windows.CloseHandle(pi.Thread)
    return pi, nil
}
func removeStaleLock(data string) error {
    path := filepath.Join(data,".workspace.lock")
    b, err := os.ReadFile(path); if os.IsNotExist(err) { return nil }; if err != nil { return err }
    var lock struct{ PID uint32 `json:"pid"` }; if json.Unmarshal(b,&lock) != nil || lock.PID == 0 { return errors.New("Workspace lock hỏng. Cần kiểm tra data trước khi phục hồi.") }
    h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, lock.PID)
    if err == nil { defer windows.CloseHandle(h); status, err := windows.WaitForSingleObject(h,0); if err != nil || status != windows.WAIT_OBJECT_0 { return errors.New("Workspace vẫn có process đang chạy; không mở instance khác.") } }
    if err != nil && !errors.Is(err, windows.ERROR_INVALID_PARAMETER) { return err }
    return os.Remove(path)
}
func run() error {
    exe, err := os.Executable(); if err != nil { return err }; root := filepath.Dir(exe)
    dataBytes, err := os.ReadFile(filepath.Join(root,"config.json")); if err != nil { return err }
    cfg := config{Port:3000,DataDir:"data"}; if err=json.Unmarshal(dataBytes,&cfg);err!=nil{return err}
    if cfg.Port < 1024 || cfg.Port > 65535 || cfg.DataDir == "" { return errors.New("config.json không hợp lệ") }
    if strings.HasPrefix(root,`\\`) { return errors.New("Vui lòng giải nén vào ổ local, không dùng ổ mạng.") }
    if !filepath.IsAbs(cfg.DataDir) { cfg.DataDir=filepath.Join(root,cfg.DataDir) }
    if strings.HasPrefix(cfg.DataDir,`\\`) { return errors.New("Workspace phải nằm trên ổ local.") }
    if err=os.MkdirAll(cfg.DataDir,0700);err!=nil{return err}
    cfg.DataDir,err=filepath.EvalSymlinks(cfg.DataDir);if err!=nil{return err}
    info:=windows.RtlGetVersion(); if info.MajorVersion < 10 || info.BuildNumber < 19045 { return errors.New("Cần Windows 10 22H2 hoặc Windows 11 bản 64-bit.") }
    user, err := windows.GetCurrentProcessToken().GetTokenUser(); if err!=nil{return err}; sid:=user.User.Sid.String()
    hash:=sha256.Sum256([]byte(strings.ToLower(cfg.DataDir)+"|"+sid)); suffix:=hex.EncodeToString(hash[:16])
    pipe:=`\\.\pipe\ftvs-`+suffix; mutexName:=`Local\FTVS-`+suffix
    mutex,err:=windows.CreateMutex(nil,false,text(mutexName)); if mutex!=0 { defer windows.CloseHandle(mutex) }
    stopMode:=strings.EqualFold(filepath.Base(exe),"Stop.exe")
    if errors.Is(err,windows.ERROR_ALREADY_EXISTS) || stopMode {
        ctx,cancel:=context.WithTimeout(context.Background(),30*time.Second);defer cancel()
        conn,e:=winio.DialPipeContext(ctx,pipe);if e!=nil{return fmt.Errorf("Không kết nối được instance đang chạy: %w",e)};defer conn.Close()
        conn.SetDeadline(time.Now().Add(35*time.Second))
        if e=writeMessage(conn,message{Action:"status"});e!=nil{return e}; status,e:=readMessage(conn);if e!=nil{return e}
        if status.Error!="" {return errors.New(status.Error)}
        if !stopMode {return openBrowser(status.URL)}
        if status.Active && !dialog("Tác vụ đang chạy. Hủy tác vụ và dừng ứng dụng?",true){return nil}
        if e=writeMessage(conn,message{Action:"stop",CancelActiveJob:status.Active,JobID:status.JobID});e!=nil{return e}
        response,e:=readMessage(conn);if e!=nil{return e};if response.Error!=""{return errors.New(response.Error)};return nil
    }
    if err!=nil{return err}
    if err=removeStaleLock(cfg.DataDir);err!=nil{return err}
    for _,p:=range []string{"runtime/node.exe","app/server/main.js","media/ffmpeg.exe","media/ffprobe.exe"} { if _,err=os.Stat(filepath.Join(root,filepath.FromSlash(p)));err!=nil{return fmt.Errorf("Gói thiếu %s. Hãy giải nén toàn bộ hoặc tải lại gói.",p)} }
    listener,err:=winio.ListenPipe(pipe,&winio.PipeConfig{SecurityDescriptor:"D:P(A;;GA;;;"+sid+")",InputBufferSize:65536,OutputBufferSize:65536});if err!=nil{return err};defer listener.Close()
    job,err:=windows.CreateJobObject(nil,nil);if err!=nil{return err};defer windows.CloseHandle(job)
    var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION;limits.BasicLimitInformation.LimitFlags=windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if _,err=windows.SetInformationJobObject(job,windows.JobObjectExtendedLimitInformation,uintptr(unsafe.Pointer(&limits)),uint32(unsafe.Sizeof(limits)));err!=nil{return err}
    secret:=make([]byte,32);if _,err=rand.Read(secret);err!=nil{return err};nonce:=hex.EncodeToString(secret)
    pi,err:=startBackend(root,cfg.DataDir,pipe,nonce,job);if err!=nil{return err};defer windows.CloseHandle(pi.Process)
    ready:=make(chan struct{});exited:=make(chan struct{});var readyOnce sync.Once
    var mu sync.Mutex;var backend net.Conn;pending:=map[string]chan message{};state:=message{URL:fmt.Sprintf("http://127.0.0.1:%d",cfg.Port)}
    go func(){windows.WaitForSingleObject(pi.Process,windows.INFINITE);close(exited);listener.Close()}()
    go func(){for {conn,e:=listener.Accept();if e!=nil{return};go func(conn net.Conn){defer conn.Close();conn.SetReadDeadline(time.Now().Add(30*time.Second));first,e:=readMessage(conn);if e!=nil{return}
        if first.Action=="ready" {
            if first.Nonce!=nonce || first.PID!=pi.ProcessId{return};conn.SetReadDeadline(time.Time{});mu.Lock();backend=conn;mu.Unlock();readyOnce.Do(func(){close(ready)})
            for {m,e:=readMessage(conn);if e!=nil{return};if m.Action=="status"{mu.Lock();state.Active=m.Active;state.JobID=m.JobID;mu.Unlock()} else if m.Action=="shutdown-response"{mu.Lock();ch:=pending[m.RequestID];mu.Unlock();if ch!=nil{select{case ch<-m:default:}}}}
        } else {
            select{case <-ready:case <-exited:return;case <-time.After(30*time.Second):writeMessage(conn,message{Error:"Ứng dụng chưa sẵn sàng"});return}
            for {mu.Lock();snapshot:=state;mu.Unlock();if first.Action=="status"||first.Action=="open"{if writeMessage(conn,snapshot)!=nil{return}} else if first.Action=="stop"{requestID:=fmt.Sprintf("%d",time.Now().UnixNano());response:=make(chan message,1);mu.Lock();b:=backend;pending[requestID]=response;if b!=nil{e=writeMessage(b,message{Action:"shutdown",RequestID:requestID,CancelActiveJob:first.CancelActiveJob,JobID:first.JobID})};mu.Unlock();defer func(){mu.Lock();delete(pending,requestID);mu.Unlock()}();if b==nil||e!=nil{writeMessage(conn,message{Error:"Backend không phản hồi"});return};select{case ack:=<-response:if ack.Error!=""{writeMessage(conn,message{Error:ack.Error});return};case <-time.After(5*time.Second):writeMessage(conn,message{Error:"Backend chưa xác nhận dừng"});return};writeMessage(conn,message{Action:"stopping"});go func(){select{case <-exited:case <-time.After(10*time.Second):windows.TerminateJobObject(job,1)}}();return}else{return};first,e=readMessage(conn);if e!=nil{return}}
        }
    }(conn)}}()
    select {case <-ready:if err=openBrowser(state.URL);err!=nil{dialog(err.Error(),false)}
    case <-exited:return errors.New("Backend không khởi động được. Kiểm tra port/config và data/logs.")
    case <-time.After(30*time.Second):windows.TerminateJobObject(job,1);return errors.New("Khởi động quá 30 giây. Kiểm tra log và port 3000.")}
    <-exited
    var code uint32;windows.GetExitCodeProcess(pi.Process,&code);if code!=0{return fmt.Errorf("Backend kết thúc bất thường (code %d). Xem data/logs.",code)}
    return nil
}
func main(){if err:=run();err!=nil{dialog(err.Error(),false);os.Exit(1)}}
