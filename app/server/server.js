import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import AWS from 'aws-sdk';

dotenv.config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));

const s3 = new AWS.S3({ region: process.env.AWS_REGION });
const Bucket = process.env.S3_BUCKET;
const URL_TTL = parseInt(process.env.SIGNED_URL_TTL_SECONDS || '900', 10);

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// List objects in a prefix (folder)
app.get('/api/list', async (req, res) => {
  try {
    const { prefix = '', token } = req.query;
    const params = {
      Bucket,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: token,
      MaxKeys: 1000,
    };
    const data = await s3.listObjectsV2(params).promise();
    res.json({
      prefix,
      commonPrefixes: (data.CommonPrefixes || []).map(p => p.Prefix),
      contents: (data.Contents || []).map(o => ({
        key: o.Key,
        size: o.Size,
        lastModified: o.LastModified,
        isFolder: o.Key.endsWith('/'),
      })),
      nextToken: data.IsTruncated ? data.NextContinuationToken : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create an empty folder (zero-byte object ending with "/")
app.post('/api/create-folder', async (req, res) => {
  try {
    const { key } = req.body; // e.g. "photos/2025/"
    if (!key || !key.endsWith('/')) {
      return res.status(400).json({ error: 'key must end with "/"' });
    }
    await s3.putObject({ Bucket, Key: key, Body: '' }).promise();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get presigned URL for upload (single-part PUT). Client performs PUT directly to S3.
app.post('/api/presign-upload', async (req, res) => {
  try {
    const { key, contentType } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });
    const url = await s3.getSignedUrlPromise('putObject', {
      Bucket,
      Key: key,
      ContentType: contentType || 'application/octet-stream',
      Expires: URL_TTL,
    });
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get presigned URL for download
app.post('/api/presign-download', async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });
    const url = await s3.getSignedUrlPromise('getObject', {
      Bucket,
      Key: key,
      Expires: URL_TTL,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(key.split('/').pop())}"`,
    });
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Delete one object (or use prefix deletion client-side by listing then calling this for each)
app.delete('/api/object', async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });
    await s3.deleteObject({ Bucket, Key: key }).promise();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Bulk delete (up to 1000 per call)
app.post('/api/delete-bulk', async (req, res) => {
  try {
    const { keys = [] } = req.body;
    if (!Array.isArray(keys) || keys.length === 0) return res.status(400).json({ error: 'keys is required' });
    const params = {
      Bucket,
      Delete: { Objects: keys.map(k => ({ Key: k })) },
    };
    const data = await s3.deleteObjects(params).promise();
    res.json({ deleted: data.Deleted || [], errors: data.Errors || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Server listening on :${port}`));
