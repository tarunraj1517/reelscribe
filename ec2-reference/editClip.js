// Reference implementation of the render-service side of the clip editor (POST /edit-clip).
// Pure Node + ffmpeg (no npm dependencies) so it can be dropped into the existing EC2 service.
//
//   mode "trim"     – cut [startSec, endSec] out of an already-rendered clip (captions stay as they are)
//   mode "rerender" – start from the caption-free master, re-frame (aspect ratio + horizontal focus),
//                     overlay the brand logo, and (via your existing caption renderer) re-burn captions.
const { spawn } = require("child_process");

const SIZES = { "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350], "16:9": [1920, 1080] };

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
    let err = "";
    p.stderr.on("data", d => (err += d));
    p.on("error", reject);
    p.on("close", code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))));
  });
}

// Crop (around a horizontal focus point) and scale to the target size.
function reframeFilter(aspect, focusX) {
  const [w, h] = SIZES[aspect] || SIZES["9:16"];
  const r = (w / h).toFixed(5);
  const fx = (Math.min(100, Math.max(0, focusX ?? 50)) / 100).toFixed(4);
  return `crop='min(iw,ih*${r})':'min(ih,iw/${r})':'(iw-min(iw,ih*${r}))*${fx}':'(ih-min(ih,iw/${r}))/2',scale=${w}:${h}:flags=lanczos,setsar=1`;
}

const LOGO_POS = {
  "top-left":     "x=W*0.04:y=H*0.04",
  "top-right":    "x=W-w-W*0.04:y=H*0.04",
  "bottom-left":  "x=W*0.04:y=H-h-H*0.04",
  "bottom-right": "x=W-w-W*0.04:y=H-h-H*0.04",
};

/**
 * @param {object} o
 * @param {string} o.inputPath    local file (download it from S3 first)
 * @param {string} o.outputPath   local mp4 to write (upload it to S3 afterwards)
 * @param {number} o.startSec
 * @param {number} o.endSec
 * @param {"trim"|"rerender"} [o.mode]
 * @param {string} [o.aspectRatio] "9:16" | "1:1" | "4:5" | "16:9"
 * @param {number} [o.focusX]     0-100, horizontal focus for the crop
 * @param {string} [o.logoPath]   local PNG/JPG/WebP logo
 * @param {string} [o.logoPosition]
 */
async function editClip(o) {
  const mode = o.mode === "rerender" ? "rerender" : "trim";
  const duration = o.endSec - o.startSec;
  if (!(duration > 0)) throw new Error("Invalid range");

  const args = ["-ss", String(o.startSec), "-i", o.inputPath];
  const useLogo = mode === "rerender" && o.logoPath;
  if (useLogo) args.push("-i", o.logoPath);
  args.push("-t", String(duration));

  if (mode === "rerender") {
    const base = reframeFilter(o.aspectRatio || "9:16", o.focusX);
    if (useLogo) {
      const pos = LOGO_POS[o.logoPosition] || LOGO_POS["top-right"];
      args.push("-filter_complex", `[0:v]${base}[v];[1:v]scale=-2:ih*0+120[lg];[v][lg]overlay=${pos}[out]`, "-map", "[out]", "-map", "0:a?");
    } else {
      args.push("-vf", base);
    }
    // → Integration point: burn captions here with your existing caption renderer,
    //   e.g. add `subtitles=...` / ASS filter built from the stored word timings + captionSettings.
  }
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", o.outputPath);
  await runFfmpeg(args);
  return { duration };
}

module.exports = { editClip, reframeFilter, SIZES };
