// Runs the reference ffmpeg editor against a generated test video (needs ffmpeg + ffprobe on PATH).
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const { editClip } = require("../ec2-reference/editClip");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-edit-"));
const src = path.join(dir, "src.mp4"), logo = path.join(dir, "logo.png");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=200x100", "-frames:v", "1", logo]);
const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,codec_type:format=duration", "-of", "json", f]).toString());

test("trim keeps the original frame size and cuts the right length", async () => {
  const out = path.join(dir, "trim.mp4");
  await editClip({ inputPath: src, outputPath: out, startSec: 2, endSec: 6, mode: "trim" });
  const p = probe(out);
  assert.ok(Math.abs(Number(p.format.duration) - 4) < 0.3);
  const v = p.streams.find(s => s.codec_type === "video");
  assert.equal(v.width, 1280); assert.equal(v.height, 720);
});

test("rerender reframes 16:9 → 9:16 with a logo overlay", async () => {
  const out = path.join(dir, "re.mp4");
  await editClip({ inputPath: src, outputPath: out, startSec: 1, endSec: 5, mode: "rerender", aspectRatio: "9:16", focusX: 20, logoPath: logo, logoPosition: "top-right" });
  const v = probe(out).streams.find(s => s.codec_type === "video");
  assert.equal(v.width, 1080); assert.equal(v.height, 1920);
});

test("rerender without a logo and to 1:1", async () => {
  const out = path.join(dir, "sq.mp4");
  await editClip({ inputPath: src, outputPath: out, startSec: 0, endSec: 3, mode: "rerender", aspectRatio: "1:1", focusX: 80 });
  const v = probe(out).streams.find(s => s.codec_type === "video");
  assert.equal(v.width, 1080); assert.equal(v.height, 1080);
});

test("invalid range is rejected", async () => { await assert.rejects(() => editClip({ inputPath: src, outputPath: path.join(dir, "x.mp4"), startSec: 5, endSec: 5 })); });
