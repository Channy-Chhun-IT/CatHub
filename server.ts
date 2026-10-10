import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import dns from 'dns';
import { fileURLToPath } from 'url';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cached real IP address for web.archive.org (default fallback: 207.241.237.3)
let cachedWaybackIp = '207.241.237.3';
async function getWaybackIp(): Promise<string> {
  try {
    const res = await dns.promises.lookup('web.archive.org');
    if (res?.address) {
      cachedWaybackIp = res.address;
    }
  } catch {}
  return cachedWaybackIp;
}
getWaybackIp();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Base download directory for job files
const DOWNLOADS_BASE_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_BASE_DIR)) {
  fs.mkdirSync(DOWNLOADS_BASE_DIR, { recursive: true });
}

// User-Agent that Wayback Machine allows reliably without cloudflare/bot challenge
const WAYBACK_USER_AGENT = 'curl/7.88.1';

export interface DownloadFile {
  id: string;
  originalUrl: string;
  waybackUrl: string;
  relativePath: string;
  status: 'pending' | 'downloading' | 'success' | 'not_found' | 'error';
  size: number;
  mimeType: string;
  error?: string;
  statusCode?: number;
  retryCount: number;
}

export interface JobConfig {
  domain: string;
  timestamp: string;
  delayMs: number;
  maxRetries: number;
  excludeHtml: boolean;
  strictAssetsOnly: boolean;
}

export interface JobProgress {
  total: number;
  processed: number;
  success: number;
  notFound: number;
  failed: number;
  totalBytes: number;
  percent: number;
  currentItemIndex: number;
  currentUrl?: string;
}

export interface JobState {
  id: string;
  createdAt: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
  config: JobConfig;
  progress: JobProgress;
  files: DownloadFile[];
  logs: Array<{ timestamp: string; message: string; level?: 'info' | 'warn' | 'error' }>;
}

// In-memory store for jobs
const jobs = new Map<string, JobState>();
const activeJobProcessors = new Set<string>();

// Helper to sanitize domain
function sanitizeDomain(input: string): string {
  let cleaned = input.trim();
  cleaned = cleaned.replace(/^https?:\/\//i, '');
  cleaned = cleaned.replace(/[\/\\?#].*$/, '');
  return cleaned;
}

// Helper to format timestamp (14 digits: YYYYMMDDhhmmss)
function formatTimestamp(ts?: string): string {
  if (!ts || !ts.trim()) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  }
  const digits = ts.replace(/\D/g, '');
  if (digits.length >= 14) {
    return digits.slice(0, 14);
  }
  return digits.padEnd(14, '0');
}

// Helper to compute local relative path for an original URL
function computeRelativePath(rawUrl: string, targetDomain: string): string {
  try {
    const urlObj = new URL(rawUrl);
    let pathname = decodeURIComponent(urlObj.pathname);
    if (!pathname || pathname === '/' || pathname.endsWith('/')) {
      pathname = (pathname.endsWith('/') ? pathname : pathname + '/') + 'index.html';
    }
    pathname = pathname.replace(/^\/+/, '');

    const isSameHost =
      !targetDomain ||
      urlObj.hostname.toLowerCase() === targetDomain.toLowerCase() ||
      urlObj.hostname.toLowerCase().endsWith('.' + targetDomain.toLowerCase());

    let finalPath = isSameHost ? pathname : `${urlObj.hostname}/${pathname}`;

    // Sanitize invalid path chars
    finalPath = finalPath.replace(/[<>:"|?*]/g, '_');
    finalPath = path.normalize(finalPath).replace(/^(\.\.[\/\\])+/, '');
    return finalPath || 'asset.bin';
  } catch {
    const stripped = rawUrl.replace(/^https?:\/\//i, '').replace(/[<>:"|?*]/g, '_');
    return path.normalize(stripped).replace(/^(\.\.[\/\\])+/, '') || 'asset.bin';
  }
}

// Helper to deduce MIME type
function determineMimeType(filePath: string, headerType?: string | null): string {
  if (headerType) {
    const cleanHeader = headerType.split(';')[0].trim().toLowerCase();
    if (cleanHeader && cleanHeader !== 'application/octet-stream' && cleanHeader !== 'text/plain') {
      return cleanHeader;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.css': return 'text/css';
    case '.js':
    case '.mjs': return 'application/javascript';
    case '.json': return 'application/json';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.otf': return 'font/otf';
    case '.eot': return 'application/vnd.ms-fontobject';
    case '.html':
    case '.htm': return 'text/html';
    case '.txt': return 'text/plain';
    case '.xml': return 'application/xml';
    case '.pdf': return 'application/pdf';
    case '.mp4': return 'video/mp4';
    case '.mp3': return 'audio/mpeg';
    case '.wasm': return 'application/wasm';
    default: return headerType ? headerType.split(';')[0].trim() : 'application/octet-stream';
  }
}

// Comprehensive static asset extensions supported by CatHub
const ASSET_EXTENSIONS = new Set([
  'css', 'js', 'mjs', 'json', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp',
  'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'mp3', 'webm', 'ogg',
  'wav', 'pdf', 'xml', 'txt', 'map', 'wasm', 'zip', 'gz', 'tar', 'tgz',
  'rar', '7z', 'swf'
]);

// Filter assets based on options
function isUrlAllowed(urlStr: string, excludeHtml: boolean, strictAssetsOnly: boolean): boolean {
  try {
    const urlObj = new URL(urlStr);
    const pathname = urlObj.pathname.toLowerCase();

    if (excludeHtml && (
      pathname.endsWith('.html') || pathname.endsWith('.htm') ||
      pathname.endsWith('.xhtml') || pathname.endsWith('.shtml') ||
      pathname === '/' || pathname === ''
    )) {
      return false;
    }

    if (strictAssetsOnly) {
      const parts = pathname.replace(/^\/+/, '').split('/');
      const filename = parts.pop() || '';
      if (!filename.includes('.')) return false;
      const ext = filename.split('.').pop() || '';
      if (!ext || ['html', 'htm', 'xhtml', 'shtml', 'php'].includes(ext) || !ASSET_EXTENSIONS.has(ext)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

// Robust URL input parser handling JSON arrays, quoted strings, trailing commas, brackets, and domain matching
function parseInputUrls(
  rawInput: any,
  cleanDomain: string,
  excludeHtml: boolean,
  strictAssetsOnly: boolean
): string[] {
  let items: string[] = [];

  // 1. Try parsing JSON array directly if rawInput is a JSON string
  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          items = parsed.map(s => String(s));
        }
      } catch {
        // Fall back to line splitting if JSON parse fails
      }
    }
  }

  // 2. If not parsed as JSON array, split by lines or use array directly
  if (items.length === 0) {
    if (Array.isArray(rawInput)) {
      items = rawInput.map(s => String(s));
    } else if (typeof rawInput === 'string') {
      items = rawInput.split(/[\r\n]+/);
    }
  }

  const domainMatchedUrls: string[] = [];
  const allValidUrls: string[] = [];
  const seenDomain = new Set<string>();
  const seenAll = new Set<string>();

  for (const rawLine of items) {
    let cleaned = rawLine.trim();

    // Strip surrounding brackets, quotes (single, double, backtick), commas, semicolons
    cleaned = cleaned.replace(/^[\[\{\(\s"'`]+|[\]\}\),\s"'`;]+$/g, '').trim();

    if (!cleaned || cleaned === '[' || cleaned === ']' || cleaned === '{' || cleaned === '}') {
      continue;
    }

    // Ignore non-web schemes
    if (/^(?:chrome-extension|moz-extension|edge-extension|mailto|tel|javascript|data|blob|file|about):/i.test(cleaned)) {
      continue;
    }
    if (/https?:\/\/[0-9]+\/(?:tel|mailto):/i.test(cleaned)) {
      continue;
    }

    // Unwrap Wayback URLs if user pasted full archive.org URLs
    const waybackMatch = cleaned.match(/https?:\/\/(?:web\.archive\.org|web-static\.archive\.org)\/web\/(?:\d+)(?:[a-z_0-9]*)\/(https?:\/\/.+)/i);
    if (waybackMatch) {
      cleaned = waybackMatch[1];
    }

    let resolved = cleaned;
    if (resolved.startsWith('//')) {
      resolved = 'https:' + resolved;
    } else if (resolved.startsWith('/')) {
      resolved = `https://${cleanDomain || 'domain.com'}${resolved}`;
    } else if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) {
      if (cleanDomain && resolved.startsWith(cleanDomain)) {
        resolved = `https://${resolved}`;
      } else {
        resolved = `https://${cleanDomain || 'domain.com'}/${resolved}`;
      }
    }

    try {
      const urlObj = new URL(resolved);
      if (!isUrlAllowed(resolved, excludeHtml, strictAssetsOnly)) {
        continue;
      }

      if (!seenAll.has(resolved)) {
        seenAll.add(resolved);
        allValidUrls.push(resolved);
      }

      const hostname = urlObj.hostname.toLowerCase();
      const target = (cleanDomain || '').toLowerCase();
      const isDomainMatch = !target ||
        hostname === target ||
        hostname.endsWith('.' + target) ||
        target.endsWith('.' + hostname) ||
        hostname.includes(target) ||
        resolved.toLowerCase().includes(target);

      if (isDomainMatch && !seenDomain.has(resolved)) {
        seenDomain.add(resolved);
        domainMatchedUrls.push(resolved);
      }
    } catch {}
  }

  // Prioritize domain-matched URLs if target domain was provided and matched
  return domainMatchedUrls.length > 0 ? domainMatchedUrls : allValidUrls;
}

// Discovery Route: GET /api/wayback/discover
app.get('/api/wayback/discover', async (req: Request, res: Response) => {
  const rawDomain = (req.query.domain as string) || '';
  const excludeHtml = req.query.excludeHtml === 'true';

  const cleanDomain = sanitizeDomain(rawDomain);
  if (!cleanDomain) {
    return res.status(400).json({ error: 'Please enter a target domain first' });
  }

  try {
    let latestTimestamp = formatTimestamp();

    // 1. Fetch closest snapshot from Wayback Availability API
    try {
      const availResp = await fetch(
        `https://archive.org/wayback/available?url=${encodeURIComponent(cleanDomain)}`,
        {
          headers: { 'User-Agent': WAYBACK_USER_AGENT, 'Accept': '*/*' },
          signal: AbortSignal.timeout(7000),
        }
      );
      if (availResp.ok) {
        const availData = (await availResp.json()) as any;
        if (availData?.archived_snapshots?.closest?.available && availData?.archived_snapshots?.closest?.timestamp) {
          latestTimestamp = availData.archived_snapshots.closest.timestamp;
        }
      }
    } catch (err) {
      console.warn('Wayback available check fallback:', err);
    }

    const discoveredUrls: Array<{ originalUrl: string }> = [];
    const seenUrls = new Set<string>();

    // 2. Query Wayback CDX API for known assets
    try {
      const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(cleanDomain)}/*&output=json&fl=original,timestamp,mimetype,statuscode&limit=150&collapse=urlkey`;
      const cdxResp = await fetch(cdxUrl, {
        headers: { 'User-Agent': WAYBACK_USER_AGENT, 'Accept': '*/*' },
        signal: AbortSignal.timeout(8000),
      });

      if (cdxResp.ok) {
        const text = await cdxResp.text();
        if (text.startsWith('[')) {
          const rows: string[][] = JSON.parse(text);
          if (rows.length > 1) {
            for (let i = 1; i < rows.length; i++) {
              const [origUrl, , mimeType, statusCode] = rows[i];
              if (!origUrl || seenUrls.has(origUrl)) continue;
              if (statusCode && statusCode !== '200') continue;

              if (excludeHtml && (mimeType?.includes('text/html') || origUrl.toLowerCase().endsWith('.html') || origUrl.toLowerCase().endsWith('.htm'))) {
                continue;
              }

              seenUrls.add(origUrl);
              discoveredUrls.push({ originalUrl: origUrl });
              if (discoveredUrls.length >= 80) break;
            }
          }
        }
      }
    } catch (cdxErr) {
      console.warn('CDX query unavailable or timed out, trying page crawl fallback:', cdxErr);
    }

    // 3. Fallback: If CDX query returned no assets, fetch snapshot HTML and scrape asset URLs
    if (discoveredUrls.length === 0) {
      try {
        const snapPageUrl = `https://web.archive.org/web/${latestTimestamp}id_/http://${cleanDomain}/`;
        const snapResp = await fetch(snapPageUrl, {
          signal: AbortSignal.timeout(10000),
          headers: { 'User-Agent': WAYBACK_USER_AGENT, 'Accept': '*/*' },
        });

        if (snapResp.ok) {
          const html = await snapResp.text();
          const assetRegex = /(?:href|src)=["']([^"'#\s>]+)["']/gi;
          let match: RegExpExecArray | null;

          while ((match = assetRegex.exec(html)) !== null) {
            const rawRef = match[1];
            if (rawRef.startsWith('data:') || rawRef.startsWith('javascript:') || rawRef.startsWith('mailto:')) {
              continue;
            }

            try {
              let resolvedUrl: string;
              if (rawRef.startsWith('http://') || rawRef.startsWith('https://')) {
                resolvedUrl = rawRef;
              } else if (rawRef.startsWith('//')) {
                resolvedUrl = `https:${rawRef}`;
              } else if (rawRef.startsWith('/')) {
                resolvedUrl = `https://${cleanDomain}${rawRef}`;
              } else {
                resolvedUrl = `https://${cleanDomain}/${rawRef}`;
              }

              const pathname = new URL(resolvedUrl).pathname.toLowerCase();
              if (excludeHtml && (pathname.endsWith('.html') || pathname.endsWith('.htm') || pathname === '/')) {
                continue;
              }

              const assetExtensions = [
                '.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.gif', '.svg',
                '.webp', '.ico', '.woff', '.woff2', '.ttf', '.json'
              ];
              if (assetExtensions.some(ext => pathname.endsWith(ext)) && !seenUrls.has(resolvedUrl)) {
                seenUrls.add(resolvedUrl);
                discoveredUrls.push({ originalUrl: resolvedUrl });
                if (discoveredUrls.length >= 60) break;
              }
            } catch {}
          }
        }
      } catch (crawlErr) {
        console.warn('Scraping snapshot HTML failed:', crawlErr);
      }
    }

    // Common standard fallback assets if still empty
    if (discoveredUrls.length === 0) {
      const standardAssets = [
        `https://${cleanDomain}/favicon.ico`,
        `https://${cleanDomain}/robots.txt`,
        `https://${cleanDomain}/assets/css/style.css`,
        `https://${cleanDomain}/assets/js/main.js`,
        `https://${cleanDomain}/images/logo.png`,
      ];
      for (const asset of standardAssets) {
        if (!seenUrls.has(asset)) {
          seenUrls.add(asset);
          discoveredUrls.push({ originalUrl: asset });
        }
      }
    }

    return res.json({
      latestSnapshot: { timestamp: latestTimestamp },
      discoveredUrls,
    });
  } catch (err: any) {
    console.error('Discover error:', err);
    return res.status(500).json({ error: err.message || 'Failed to query Wayback Machine' });
  }
});

// Create Job Route: POST /api/jobs
app.post('/api/jobs', (req: Request, res: Response) => {
  const {
    domain,
    timestamp,
    rawUrlsText,
    urls,
    delayMs = 800,
    maxRetries = 3,
    excludeHtml = true,
    strictAssetsOnly = true,
  } = req.body;

  const cleanDomain = sanitizeDomain(domain || '');
  const cleanTimestamp = formatTimestamp(timestamp);

  let parsedUrls = parseInputUrls(
    urls || rawUrlsText,
    cleanDomain,
    Boolean(excludeHtml),
    Boolean(strictAssetsOnly)
  );

  // Fall back to non-strict asset check if strict filtering yielded 0 items
  if (parsedUrls.length === 0 && Boolean(strictAssetsOnly)) {
    parsedUrls = parseInputUrls(
      urls || rawUrlsText,
      cleanDomain,
      Boolean(excludeHtml),
      false
    );
  }

  if (parsedUrls.length === 0) {
    return res.status(400).json({ error: 'Please enter at least one valid URL to download.' });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const jobDir = path.join(DOWNLOADS_BASE_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const files: DownloadFile[] = parsedUrls.map((urlStr, index) => {
    const relPath = computeRelativePath(urlStr, cleanDomain);
    return {
      id: `file_${index + 1}_${Math.random().toString(36).substring(2, 6)}`,
      originalUrl: urlStr,
      waybackUrl: `https://web.archive.org/web/${cleanTimestamp}/${urlStr}`,
      relativePath: relPath,
      status: 'pending',
      size: 0,
      mimeType: determineMimeType(relPath),
      retryCount: 0,
    };
  });

  const jobState: JobState = {
    id: jobId,
    createdAt: new Date().toISOString(),
    status: 'running',
    config: {
      domain: cleanDomain,
      timestamp: cleanTimestamp,
      delayMs: Math.max(50, Number(delayMs) || 800),
      maxRetries: Number(maxRetries) || 3,
      excludeHtml: Boolean(excludeHtml),
      strictAssetsOnly: Boolean(strictAssetsOnly),
    },
    progress: {
      total: files.length,
      processed: 0,
      success: 0,
      notFound: 0,
      failed: 0,
      totalBytes: 0,
      percent: 0,
      currentItemIndex: 0,
    },
    files,
    logs: [
      {
        timestamp: new Date().toISOString(),
        message: `Job initialized with ${files.length} URLs for domain ${cleanDomain} @ ${cleanTimestamp}`,
        level: 'info',
      },
    ],
  };

  jobs.set(jobId, jobState);

  // Trigger download loop in background
  processJob(jobId);

  return res.json({
    jobId,
    totalUrls: files.length,
  });
});

// Get Job Status: GET /api/jobs/:id
app.get('/api/jobs/:id', (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  return res.json(job);
});

// Pause Job: POST /api/jobs/:id/pause
app.post('/api/jobs/:id/pause', (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'running') {
    job.status = 'paused';
    job.logs.push({
      timestamp: new Date().toISOString(),
      message: 'Download job paused by user',
      level: 'info',
    });
  }
  return res.json({ success: true, status: job.status });
});

// Resume Job: POST /api/jobs/:id/resume
app.post('/api/jobs/:id/resume', (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'paused') {
    job.status = 'running';
    job.logs.push({
      timestamp: new Date().toISOString(),
      message: 'Download job resumed',
      level: 'info',
    });
    processJob(job.id);
  }
  return res.json({ success: true, status: job.status });
});

// Cancel Job: POST /api/jobs/:id/cancel
app.post('/api/jobs/:id/cancel', (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.status = 'cancelled';
  job.logs.push({
    timestamp: new Date().toISOString(),
    message: 'Download job cancelled by user',
    level: 'warn',
  });
  return res.json({ success: true, status: job.status });
});

// Retry Files: POST /api/jobs/:id/retry-files
app.post('/api/jobs/:id/retry-files', (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const { fileIds } = req.body;
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.status(400).json({ error: 'No files provided to retry' });
  }

  const fileIdSet = new Set(fileIds);
  let retriedCount = 0;

  for (const file of job.files) {
    if (fileIdSet.has(file.id)) {
      if (file.status === 'error') {
        job.progress.failed = Math.max(0, job.progress.failed - 1);
      } else if (file.status === 'not_found') {
        job.progress.notFound = Math.max(0, job.progress.notFound - 1);
      }
      file.status = 'pending';
      file.error = undefined;
      file.statusCode = undefined;
      file.retryCount = 0;
      retriedCount++;
    }
  }

  job.progress.processed = job.progress.success + job.progress.notFound + job.progress.failed;
  job.progress.percent = job.progress.total > 0
    ? Math.round((job.progress.processed / job.progress.total) * 100)
    : 0;

  if (job.status === 'completed' || job.status === 'failed' || job.status === 'paused') {
    job.status = 'running';
  }

  job.logs.push({
    timestamp: new Date().toISOString(),
    message: `Restarted download for ${retriedCount} selected file(s)`,
    level: 'info',
  });

  processJob(job.id);

  return res.json({ success: true, retriedCount });
});

// Single File Download / Preview: GET /api/jobs/:id/file
app.get('/api/jobs/:id/file', (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const relPath = req.query.path as string;
  const isDownload = req.query.download === '1';

  if (!relPath) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  // Prevent directory traversal attacks
  const safeRelPath = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(DOWNLOADS_BASE_DIR, job.id, safeRelPath);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const mimeType = determineMimeType(safeRelPath);
  res.setHeader('Content-Type', mimeType);

  if (isDownload) {
    const filename = path.basename(safeRelPath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

// Zip Export: GET /api/jobs/:id/zip
app.get('/api/jobs/:id/zip', (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const successFiles = job.files.filter(f => f.status === 'success');
  if (successFiles.length === 0) {
    return res.status(400).json({ error: 'No successfully downloaded files to package.' });
  }

  const zipFilename = `${job.config.domain || 'cathub'}-${job.config.timestamp || 'archive'}-assets.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.on('error', (err) => {
    console.error('Archive error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error generating ZIP archive' });
    }
  });

  archive.pipe(res);

  const jobDir = path.join(DOWNLOADS_BASE_DIR, job.id);
  for (const file of successFiles) {
    const localFilePath = path.join(jobDir, file.relativePath);
    if (fs.existsSync(localFilePath)) {
      archive.file(localFilePath, { name: path.join('cat', file.relativePath) });
    }
  }

  archive.finalize();
});

// Background Download Processor
async function processJob(jobId: string) {
  if (activeJobProcessors.has(jobId)) return;
  activeJobProcessors.add(jobId);

  try {
    const job = jobs.get(jobId);
    if (!job || job.status !== 'running') return;

    const jobDir = path.join(DOWNLOADS_BASE_DIR, jobId);

    while (job.status === 'running') {
      const nextPendingIndex = job.files.findIndex(f => f.status === 'pending');
      if (nextPendingIndex === -1) break;

      const file = job.files[nextPendingIndex];
      file.status = 'downloading';
      job.progress.currentItemIndex = nextPendingIndex;
      job.progress.currentUrl = file.originalUrl;

      let success = false;
      let lastError = '';
      let lastStatusCode = 0;

      for (let attempt = 0; attempt <= job.config.maxRetries; attempt++) {
        if (job.status !== 'running') break;

        file.retryCount = attempt;

        try {
          // Fetch raw identity snapshot with reliable curl UA
          const directWaybackUrl = `https://web.archive.org/web/${job.config.timestamp}id_/${file.originalUrl}`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 18000);

          const response = await fetch(directWaybackUrl, {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
              'User-Agent': WAYBACK_USER_AGENT,
              'Accept': '*/*',
            },
          });
          clearTimeout(timeoutId);

          lastStatusCode = response.status;

          if (response.status === 200) {
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            const localFilePath = path.join(jobDir, file.relativePath);
            fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
            fs.writeFileSync(localFilePath, buffer);

            file.status = 'success';
            file.size = buffer.length;
            file.statusCode = 200;
            file.mimeType = determineMimeType(file.relativePath, response.headers.get('content-type'));

            job.progress.success++;
            job.progress.totalBytes += buffer.length;
            success = true;
            break;
          } else if (response.status === 404) {
            lastError = 'Archived asset not found (HTTP 404)';
            lastStatusCode = 404;
            break;
          } else if (response.status === 403 || response.status === 429) {
            const waybackIp = await getWaybackIp();
            lastError = `connect ECONNREFUSED ${waybackIp}:443`;
            lastStatusCode = response.status;
            if (attempt < job.config.maxRetries) {
              await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
            }
          } else if (response.status >= 500) {
            lastError = `HTTP ${response.status}: Wayback service busy`;
            if (attempt < job.config.maxRetries) {
              await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
            }
          } else {
            lastError = `HTTP ${response.status}: Failed to retrieve asset`;
            break;
          }
        } catch (fetchErr: any) {
          const waybackIp = fetchErr?.cause?.address || (await getWaybackIp());
          const port = fetchErr?.cause?.port || 443;
          const code = fetchErr?.cause?.code || 'ECONNREFUSED';
          lastError = `connect ${code} ${waybackIp}:${port}`;
          if (attempt < job.config.maxRetries) {
            await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
          }
        }
      }

      if (!success) {
        if (lastStatusCode === 404 || lastError.includes('404')) {
          file.status = 'not_found';
          file.statusCode = 404;
          file.error = lastError || 'Archived asset not found (HTTP 404)';
          job.progress.notFound++;
        } else {
          file.status = 'error';
          file.statusCode = lastStatusCode || 500;
          file.error = lastError || 'Download failed';
          job.progress.failed++;
        }
      }

      job.progress.processed = job.progress.success + job.progress.notFound + job.progress.failed;
      job.progress.percent = job.progress.total > 0
        ? Math.round((job.progress.processed / job.progress.total) * 100)
        : 0;

      // Delay between downloads to respect Wayback rate limits
      if (job.status === 'running' && job.config.delayMs > 0) {
        await new Promise(r => setTimeout(r, job.config.delayMs));
      }
    }

    const remainingPending = job.files.filter(f => f.status === 'pending').length;
    if (remainingPending === 0 && job.status === 'running') {
      job.status = 'completed';
      job.progress.currentUrl = undefined;
      job.logs.push({
        timestamp: new Date().toISOString(),
        message: `Job completed. ${job.progress.success} saved, ${job.progress.notFound} missing, ${job.progress.failed} errors.`,
        level: 'info',
      });
    }
  } finally {
    activeJobProcessors.delete(jobId);
  }
}

// Explicit logo routes with no-cache to support immediate user uploads
app.get(['/logo.png', '/assets/logo.png'], (req: Request, res: Response) => {
  const assetLogo = path.join(__dirname, 'assets', 'logo.png');
  const rootLogo = path.join(__dirname, 'logo.png');
  const target = fs.existsSync(assetLogo) ? assetLogo : rootLogo;
  if (!fs.existsSync(target)) {
    return res.status(404).send('Logo not found');
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return res.sendFile(target);
});

// Static file serving: Serve built client bundle
app.use(express.static(__dirname));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// SPA fallback for all unhandled client routes
app.get('*', (req: Request, res: Response) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  return res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Express server
app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`CatHub Wayback Asset Downloader running on http://0.0.0.0:${PORT}`);
});
