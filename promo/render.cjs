const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const fps = 24;
const seconds = 15;
const frames = fps * seconds;
const root = resolve(__dirname, "..");
const output = resolve(process.argv[2] || resolve(root, "promo/wechat-fastbridge-promo.mp4"));
const ffmpeg = process.env.FFMPEG_BIN || require("ffmpeg-static");
const language = process.env.PROMO_LANG === "zh" ? "zh" : "en";
if (!ffmpeg) throw new Error("Install ffmpeg-static or set FFMPEG_BIN to a local ffmpeg executable.");

function writeSoundtrack(path) {
  const rate = 48000;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  const beatTimes = [0,.45,.9,2.75,3.2,4.3,5.85,6.25,6.65,7.05,9.35,10.1,12.45,13.1,14.25];
  for (let i=0;i<samples;i++) {
    const t=i/rate;
    let v=.018*Math.sin(2*Math.PI*(55+8*Math.sin(t*.4))*t);
    for (const b of beatTimes) {
      const d=t-b;
      if (d>=0 && d<.28) v += .16*Math.exp(-d*18)*Math.sin(2*Math.PI*(95-120*d)*d);
      if (d>=0 && d<.045) v += .025*(Math.random()*2-1)*Math.exp(-d*70);
    }
    if (t>12.35) v += .035*Math.sin(2*Math.PI*220*t)*Math.min(1,(t-12.35)/.7)*Math.min(1,(15-t)/.7);
    data.writeInt16LE(Math.max(-1,Math.min(1,v))*32767,i*2);
  }
  const header=Buffer.alloc(44); header.write("RIFF",0); header.writeUInt32LE(36+data.length,4); header.write("WAVEfmt ",8); header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22); header.writeUInt32LE(rate,24); header.writeUInt32LE(rate*2,28); header.writeUInt16LE(2,32); header.writeUInt16LE(16,34); header.write("data",36); header.writeUInt32LE(data.length,40);
  writeFileSync(path,Buffer.concat([header,data]));
}

(async()=>{
  mkdirSync(resolve(output,".."),{recursive:true});
  const audio=resolve(__dirname,"promo-soundtrack.wav"); writeSoundtrack(audio);
  const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",args:["--hide-scrollbars","--force-device-scale-factor=1"]});
  const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
  const sourceUrl = pathToFileURL(resolve(__dirname,"index.html"));
  if(language === "zh") sourceUrl.searchParams.set("lang", "zh");
  await page.goto(sourceUrl.href); await page.evaluate(()=>document.fonts.ready);
  const proc=spawn(ffmpeg,["-y","-f","image2pipe","-vcodec","mjpeg","-framerate",String(fps),"-i","-","-i",audio,"-c:v","libx264","-preset","slow","-crf","17","-pix_fmt","yuv420p","-c:a","aac","-b:a","192k","-shortest","-movflags","+faststart",output],{stdio:["pipe","inherit","inherit"]});
  for(let frame=0;frame<frames;frame++){
    await page.evaluate((f)=>window.setFrame(f),frame);
    const shot=await page.screenshot({type:"jpeg",quality:94});
    if(!proc.stdin.write(shot)) await new Promise(r=>proc.stdin.once("drain",r));
    if(frame%48===0) process.stdout.write(`frame ${frame}/${frames}\n`);
  }
  proc.stdin.end(); await browser.close();
  const code=await new Promise(r=>proc.on("close",r)); if(code!==0) process.exit(code);
  process.stdout.write(`${output}\n`);
})().catch(e=>{console.error(e);process.exit(1)});
