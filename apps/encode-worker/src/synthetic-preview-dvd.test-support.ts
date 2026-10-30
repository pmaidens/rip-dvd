import { execFileSync } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Requires the coordinated Linux native-media lane; creates only synthetic DVD content. */
export function authorSyntheticPreviewDvd(root: string, originals: string) {
  const source = join(originals, "synthetic.iso");
  const video = join(root, "video.mpg");
  const dvd = join(root, "dvd");
  const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: "pipe", env: { ...process.env, VIDEO_FORMAT: "NTSC" } });
  run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=720x480:r=30000/1001", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", "-target", "ntsc-dvd", "-ac", "2", "-threads", "1", video]);
  const subtitle = join(root, "subtitle.png");
  run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=160x32,drawbox=x=4:y=4:w=152:h=24:color=white:t=fill", "-frames:v", "1", "-threads", "1", subtitle]);
  const subtitles = join(root, "subtitles.xml"), subtitled = join(root, "subtitled.mpg"), authoring = join(root, "dvd.xml");
  writeFileSync(subtitles, `<subpictures><stream><spu start="00:00:00.500" end="00:00:02.500" image="${subtitle}" xoffset="280" yoffset="400" /></stream></subpictures>`);
  const videoInput = openSync(video, "r"), subtitleOutput = openSync(subtitled, "wx");
  try { execFileSync("spumux", [subtitles], { stdio: [videoInput, subtitleOutput, "pipe"] }); }
  finally { closeSync(videoInput); closeSync(subtitleOutput); }
  writeFileSync(authoring, `<dvdauthor dest="${dvd}"><vmgm /><titleset><titles><video format="ntsc" aspect="4:3" /><audio lang="en" /><subpicture lang="fr" /><pgc><vob file="${subtitled}" /></pgc></titles></titleset></dvdauthor>`);
  run("dvdauthor", ["-x", authoring]);
  run("genisoimage", ["-quiet", "-dvd-video", "-udf", "-o", source, dvd]);
  return source;
}
