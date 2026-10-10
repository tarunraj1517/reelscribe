# Render-service (EC2) upgrade — needed for the clip editor, uploads and brand logo

The website side of every feature is done. These four features also need small additions to the
EC2 clip service (which is not part of this repo). Until then the site degrades gracefully: the editor
returns *"The editor isn't enabled on the render server yet … You were not charged"*.

## 1. `POST /analyze-video` — new/extra fields

Request body (existing fields unchanged, new ones marked ★):

```json
{
  "url": "https://youtube.com/...",          // when sourceType = "youtube"
  "sourceKey": "uploads/<hash>/<uuid>.mp4",   // ★ when sourceType = "upload" (download it from S3)
  "sourceType": "youtube" | "upload",         // ★
  "captionSettings": { "...": "..." , "reframe": { "mode": "focus", "focusX": 30 } }, // ★ reframe is optional
  "brandKit": { "logoUrl": "", "logoPosition": "top-right", "primaryColor": "#8b5cf6",
                "accentColor": "#ec4899", "fontName": "", "handle": "", "outroText": "" }, // ★ null when none
  "plan": "starter", "referralCut": false, "watermark": false
}
```

Response — return these **extra** fields so the editor/AI features can work:

```json
{
  "success": true,
  "videoTitle": "…",
  "clips": [{
    "title": "…", "reason": "…", "duration": 34, "url": "https://…/clip.mp4", "s3Key": "clips/….mp4",
    "sourceKey": "masters/….mp4",   // ★ the SAME clip rendered WITHOUT captions (kept on S3). Enables re-caption / re-frame / logo edits.
    "transcript": "…spoken words of the clip…"   // ★ optional, makes the AI virality score much better
  }]
}
```

* For `sourceType = "upload"` enforce `maxVideoMinutes` for the plan yourself (the web server can't probe the object).
* Overlay `brandKit.logoUrl` at `logoPosition` when present (see `ec2-reference/editClip.js`, `LOGO_POS`).
* Masters (`sourceKey`) are deleted by the web server's sweep when the job expires (24 h).
* Free "referral" cuts keep getting `watermark: true` and **no** brandKit.

## 2. `POST /edit-clip` (new)

Header `x-internal-key` as for the other endpoints.

```json
{ "inputKey": "<s3 key>", "mode": "trim" | "rerender", "startSec": 2.5, "endSec": 31,
  "focusX": 30, "aspectRatio": "9:16", "captionSettings": {…}, "brandKit": {…}, "plan": "pro" }
```

* `trim` → `inputKey` is the finished clip. Cut `[startSec,endSec]` and re-encode (captions stay as burned).
* `rerender` → `inputKey` is the caption-free master. Re-frame (`aspectRatio`, `focusX`), overlay the logo, **then run your
  existing caption renderer** with `captionSettings`.
* Respond `{ "success": true, "clip": { "url": "…", "s3Key": "…", "duration": 28 } }`.

Drop-in route (uses the tested ffmpeg helper in `ec2-reference/editClip.js`):

```js
const { editClip } = require("./editClip");
app.post("/edit-clip", internalAuth, async (req, res) => {
  const { inputKey, mode, startSec, endSec, focusX, aspectRatio, brandKit } = req.body;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "edit-"));
  try {
    const input = path.join(dir, "in.mp4"), output = path.join(dir, "out.mp4");
    await downloadFromS3(inputKey, input);                       // your existing helper
    let logoPath;
    if (mode === "rerender" && brandKit?.logoUrl) { logoPath = path.join(dir, "logo"); await downloadUrl(brandKit.logoUrl, logoPath); }
    const { duration } = await editClip({ inputPath: input, outputPath: output, startSec, endSec, mode, aspectRatio, focusX, logoPath, logoPosition: brandKit?.logoPosition });
    const s3Key = `clips/${crypto.randomUUID()}.mp4`;
    const url = await uploadToS3(output, s3Key);                 // your existing helper
    res.json({ success: true, clip: { url, s3Key, duration } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: "Render failed" }); }
  finally { fs.promises.rm(dir, { recursive: true, force: true }); }
});
```

## 3. S3 bucket CORS (for direct uploads from the browser)

```json
[{ "AllowedOrigins": ["https://reelscribe.site", "https://www.reelscribe.site"],
   "AllowedMethods": ["PUT"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3000 }]
```

Also add a lifecycle rule that expires `uploads/` objects after 1 day (the web server deletes them after a job, this is the safety net).
The IAM user used by the web server needs `s3:PutObject` and `s3:DeleteObject` on `uploads/*` and `brand/*`.
`brand/*` (logos) must be publicly readable like your clips, or served via CloudFront.

## 4. Not included (needs ML / third-party approval)

* **Face-tracking auto reframe** – the editor ships a manual horizontal *focus point*. True tracking needs a face/speaker detector
  (e.g. MediaPipe) in the render service; pass its result as `captionSettings.reframe.focusX`.
* **Auto-posting** to YouTube/Instagram/TikTok – needs each platform's OAuth app review. The scheduler already has an adapter hook
  (`ADAPTERS` in `routes/scheduler.js`); until then it sends a reminder email with the caption and download link.
