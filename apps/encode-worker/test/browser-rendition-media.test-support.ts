import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// A synthetic white rectangle on a transparent 160x90 PGS canvas. The real
// media gate decodes this and encodes it as DVD bitmap subtitles, requiring no
// copyrighted disc fixture or extra subtitle-generation tool.
// Packet framing and RLE follow FFmpeg's supdec.c and pgssubdec.c:
// https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/supdec.c
// https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/pgssubdec.c
function syntheticBitmapSubtitle() {
  const word = (value: number) => { const result = Buffer.alloc(2); result.writeUInt16BE(value); return result; };
  const packet = (pts: number, type: number, payload: Buffer) => {
    const header = Buffer.alloc(13); header.write("PG"); header.writeUInt32BE(pts, 2); header[10] = type; header.writeUInt16BE(payload.length, 11);
    return Buffer.concat([header, payload]);
  };
  const presentation = (visible: boolean) => Buffer.concat([word(160), word(90), Buffer.from([0x10]), word(visible ? 0 : 1), Buffer.from([visible ? 0x80 : 0, 0, 0, visible ? 1 : 0]),
    ...(visible ? [word(0), Buffer.from([0, 0]), word(40), word(64)] : [])]);
  const rle = Buffer.concat(Array.from({ length: 16 }, () => Buffer.concat([Buffer.alloc(80, 1), Buffer.from([0, 0])])));
  const length = Buffer.alloc(3); length.writeUIntBE(rle.length + 4, 0, 3);
  return Buffer.concat([
    packet(45_000, 0x16, presentation(true)),
    packet(45_000, 0x17, Buffer.concat([Buffer.from([1, 0]), word(0), word(0), word(160), word(90)])),
    packet(45_000, 0x14, Buffer.from([0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255])),
    packet(45_000, 0x15, Buffer.concat([word(0), Buffer.from([0, 0xc0]), length, word(80), word(16), rle])),
    packet(45_000, 0x80, Buffer.alloc(0)), packet(225_000, 0x16, presentation(false)), packet(225_000, 0x80, Buffer.alloc(0)),
  ]);
}
export type SyntheticViewingVariant = "compatible" | "incompatible" | "audio_conversion" | "video_format" | "subtitles";
export function createSyntheticViewingSource(directory: string, variant: SyntheticViewingVariant) {
  const source = join(directory, `synthetic-${variant}.mkv`);
  const args = ["-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i", "color=c=black:size=160x90:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"];
  if (variant === "subtitles") {
    const bitmap = join(directory, "synthetic-captions.sup"), text = join(directory, "synthetic-captions.srt");
    writeFileSync(bitmap, syntheticBitmapSubtitle());
    writeFileSync(text, "1\n00:00:00,500 --> 00:00:02,500\nSYNTHETIC CAPTIONS\n");
    args.push("-fix_sub_duration", "-i", bitmap, "-i", text);
  }
  args.push("-map", "0:v:0", "-map", "1:a:0");
  if (variant === "subtitles") args.push("-map", "2:s:0", "-map", "3:s:0", "-c:s:0", "dvdsub", "-c:s:1", "srt", "-metadata:s:s:0", "language=eng", "-metadata:s:s:0", "title=Synthetic bitmap captions", "-metadata:s:s:1", "language=fra", "-metadata:s:s:1", "title=Synthetic text captions");
  const incompatible = variant === "incompatible" || variant === "subtitles";
  args.push("-t", "3", "-c:v", incompatible ? "mpeg2video" : "libx264", "-threads:v", "1");
  if (!incompatible) args.push("-profile:v", variant === "video_format" ? "high10" : "high", "-level:v", "4.1");
  args.push("-pix_fmt", variant === "video_format" ? "yuv420p10le" : "yuv420p", "-c:a", incompatible || variant === "audio_conversion" ? "ac3" : "aac", "-metadata:s:a:0", "language=eng", source);
  execFileSync("ffmpeg", args, { stdio: "pipe" });
  return source;
}
