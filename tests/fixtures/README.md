# Synthetic fixtures

`zip64-envelope.zip` contains only `hello.txt` with the text `hello zip64` and a newline. It was created locally with Python's standard `zipfile`, forcing ZIP64 and using valid sentinel entry counts in the legacy footer. Python `ZipFile.testzip()` and read-back both passed after generation. No user data or third-party assets are included.

The core envelope test uses this fixed 244-byte ZIP to exercise ZIP64 count/offset/truncation checks. It does not prove that the production Archiver adapter produces valid archives. That is a separate integration test requiring Archiver, yauzl, FFmpeg and Windows CMD for the Windows-specific path.

Python is a fixture-generation tool only, not an application runtime requirement.
