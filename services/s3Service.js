const { S3Client, DeleteObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const fs = require("fs");

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET = process.env.AWS_BUCKET_NAME;

function publicUrl(key) {
  return `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

async function uploadToS3(localFilePath, key, contentType = "video/mp4") {
  const upload = new Upload({
    client: s3,
    params: { Bucket: BUCKET, Key: key, Body: fs.createReadStream(localFilePath), ContentType: contentType }
  });
  await upload.done();
  return publicUrl(key);
}

// Small in-memory uploads (brand logos).
async function uploadBufferToS3(buffer, key, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  return publicUrl(key);
}

// Browser uploads straight to S3 (so large source videos never pass through the Render server).
// ContentLength is signed, so the upload must match the declared (already plan-checked) size.
async function presignUpload(key, contentType, contentLength, expiresIn = 900) {
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType, ContentLength: contentLength });
  return getSignedUrl(s3, cmd, { expiresIn });
}

async function deleteFromS3(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { uploadToS3, uploadBufferToS3, presignUpload, deleteFromS3, publicUrl };
