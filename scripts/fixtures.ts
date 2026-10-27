import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
const root = resolve('tests/generated-fixtures/mixed');
await mkdir(root, { recursive: true });
for (let i = 0; i < 24; i++) {
  const svg = Buffer.from(
    `<svg width="320" height="180"><rect width="320" height="180" fill="hsl(${i * 15},60%,40%)"/><text x="160" y="105" font-size="64" text-anchor="middle" fill="white">${i}</text></svg>`,
  );
  const ext = i % 3 === 0 ? 'png' : i % 3 === 1 ? 'jpeg' : 'webp';
  await sharp(svg)
    .toFormat(ext)
    .toFile(resolve(root, `frame_${String(i).padStart(4, '0')}.${ext}`));
}
await writeFile(
  resolve(root, 'README.txt'),
  'Synthetic generated fixtures; no user media. Each file is one numbered frame.\n',
);
console.log(root);

const edge = resolve('tests/generated-fixtures/edge-cases');
await mkdir(edge, { recursive: true });
await sharp({create:{width:100,height:200,channels:3,background:'red'}}).withMetadata({orientation:6}).jpeg().toFile(resolve(edge,'rotated.jpg'));
await sharp({create:{width:100,height:100,channels:4,background:{r:255,g:0,b:0,alpha:0.5}}}).png().toFile(resolve(edge,'alpha.png'));
await writeFile(resolve(edge,'broken.png'), 'intentionally corrupt synthetic fixture');
for (const [name, seconds] of [['short.wav',0.1],['long.wav',2]] as const) {
  const samples=Math.round(seconds*48000), wave=Buffer.alloc(44+samples*2);
  wave.write('RIFF',0); wave.writeUInt32LE(wave.length-8,4); wave.write('WAVEfmt ',8);
  wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);
  wave.writeUInt32LE(48000,24);wave.writeUInt32LE(96000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);
  wave.write('data',36);wave.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++)wave.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/48000)*8000),44+i*2);
  await writeFile(resolve(edge,name),wave);
}
