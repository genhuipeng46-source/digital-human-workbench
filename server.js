import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const VOICES_FILE = path.join(DATA_DIR, 'voices.json');
const VIDEOS_FILE = path.join(DATA_DIR, 'videos.json');

for (const dir of [DATA_DIR, UPLOADS_DIR, OUTPUTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const DEFAULT_CONFIG = {
  workbenchName: process.env.WORKBENCH_NAME || '数字人智能体工作台',
  hzagentBaseUrl: process.env.HZAGENT_BASE_URL || 'https://api.ai.hzagent.cn',
  hzagentApiKey: process.env.HZAGENT_API_KEY || '',
  hzagentExtractPath: process.env.HZAGENT_EXTRACT_PATH || '/v1/video-copy/extractions',
  hzagentExtractTaskPath: process.env.HZAGENT_EXTRACT_TASK_PATH || '/v1/video-copy/tasks',
  hzagentLipsyncPath: process.env.HZAGENT_LIPSYNC_PATH || '/v1/avatar-lipsync/generations',
  hzagentTaskPath: process.env.HZAGENT_TASK_PATH || '/v1/avatar-lipsync/tasks',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  minimaxBaseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimax.cn',
  minimaxApiKey: process.env.MINIMAX_API_KEY || '',
  minimaxDefaultVoiceId: process.env.MINIMAX_DEFAULT_VOICE_ID || '',
  minimaxTtsModel: process.env.MINIMAX_TTS_MODEL || 'speech-2.8-hd',
  defaultAvatarVideoUrl: '',
  defaultAvatarVideoName: '',
  kaipaiAccessKey: process.env.KAIPAI_ACCESS_KEY || '',
  kaipaiBin: process.env.KAIPAI_BIN || '',
};

const BUILTIN_MINIMAX_VOICES = [
  { voice_id: 'male-qn-qingse', name: '青涩青年音色（男）', source: 'builtin' },
  { voice_id: 'male-qn-jingying', name: '精英青年音色（男）', source: 'builtin' },
  { voice_id: 'male-qn-badao', name: '霸道青年音色（男）', source: 'builtin' },
  { voice_id: 'female-shaonv', name: '少女音色（女）', source: 'builtin' },
  { voice_id: 'female-yujie', name: '御姐音色（女）', source: 'builtin' },
  { voice_id: 'female-chengshu', name: '成熟女性音色（女）', source: 'builtin' },
  { voice_id: 'presenter_male', name: '男性主持人', source: 'builtin' },
  { voice_id: 'presenter_female', name: '女性主持人', source: 'builtin' },
  { voice_id: 'audiobook_male_1', name: '男性有声书 1', source: 'builtin' },
  { voice_id: 'audiobook_female_1', name: '女性有声书 1', source: 'builtin' },
];

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...saved };
    }
  } catch (err) {
    console.error('Failed to read config.json:', err.message);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(partial) {
  const current = loadConfig();
  const next = { ...current };
  for (const [k, v] of Object.entries(partial)) {
    if (k in DEFAULT_CONFIG && v !== undefined) {
      next[k] = typeof v === 'string' ? v.trim() : v;
    }
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

function loadClonedVoices() {
  try {
    if (fs.existsSync(VOICES_FILE)) {
      return JSON.parse(fs.readFileSync(VOICES_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Failed to read voices.json:', err.message);
  }
  return [];
}

function saveClonedVoice(voice) {
  const list = loadClonedVoices();
  const filtered = list.filter((item) => item.voice_id !== voice.voice_id);
  filtered.unshift({ ...voice, source: 'cloned', createdAt: new Date().toISOString() });
  fs.writeFileSync(VOICES_FILE, JSON.stringify(filtered, null, 2), 'utf-8');
  return filtered;
}

function loadVideos() {
  let list = [];
  try {
    if (fs.existsSync(VIDEOS_FILE)) {
      list = JSON.parse(fs.readFileSync(VIDEOS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Failed to read videos.json:', err.message);
  }

  // 自动补录 outputs/ 目录下尚未记录的 .mp4 文件（跳过临时源文件 kaipai_src_）
  try {
    const knownUrls = new Set(list.map((v) => v.url));
    const files = fs.readdirSync(OUTPUTS_DIR).filter((f) => /\.mp4$/i.test(f) && !f.startsWith('kaipai_src_'));
    let changed = false;
    for (const f of files) {
      const url = `/outputs/${f}`;
      if (!knownUrls.has(url)) {
        const stat = fs.statSync(path.join(OUTPUTS_DIR, f));
        const isKaipai = /kaipai|subtitled|smartedit/i.test(f);
        list.push({
          id: `vid_${stat.mtimeMs.toFixed(0)}_${f.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`,
          title: f.replace(/\.mp4$/i, ''),
          source: isKaipai ? '开拍成片' : '数字人视频',
          url,
          remoteUrl: '',
          size: stat.size,
          createdAt: stat.mtime.toISOString(),
        });
        changed = true;
      }
    }
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (changed) {
      fs.writeFileSync(VIDEOS_FILE, JSON.stringify(list, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('Failed to sync outputs dir:', err.message);
  }
  return list;
}

function saveVideoRecord(record) {
  const list = loadVideos();
  const filtered = list.filter((v) =>
    v.id !== record.id &&
    v.url !== record.url &&
    (!record.remoteUrl || v.remoteUrl !== record.remoteUrl)
  );
  filtered.unshift({
    id: record.id || `vid_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: record.title || '未命名成片',
    source: record.source || '成片',
    url: record.url,
    remoteUrl: record.remoteUrl || '',
    size: record.size || 0,
    createdAt: record.createdAt || new Date().toISOString(),
  });
  fs.writeFileSync(VIDEOS_FILE, JSON.stringify(filtered, null, 2), 'utf-8');
  return filtered;
}

async function cacheRemoteVideoLocally(remoteUrl, prefix = 'video') {
  if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) return null;
  try {
    const existing = loadVideos().find((v) => v.remoteUrl === remoteUrl);
    if (existing && existing.url && existing.url.startsWith('/outputs/')) {
      const existingPath = path.join(OUTPUTS_DIR, path.basename(existing.url));
      if (fs.existsSync(existingPath)) {
        return { url: existing.url, size: existing.size || fs.statSync(existingPath).size };
      }
    }
    const resp = await fetch(remoteUrl);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    const filename = `${prefix}_${Date.now()}.mp4`;
    fs.writeFileSync(path.join(OUTPUTS_DIR, filename), buf);
    return { url: `/outputs/${filename}`, size: buf.length };
  } catch (err) {
    console.error('Failed to cache remote video:', err.message);
    return null;
  }
}

function resolveKaipaiBin(cfg) {
  const candidates = [
    cfg.kaipaiBin,
    '/Users/penggenhui/.hermes/node/bin/kaipai',
    '/usr/local/bin/kaipai',
    '/opt/homebrew/bin/kaipai',
    'kaipai',
  ].filter(Boolean);

  for (const bin of candidates) {
    if (bin === 'kaipai') return bin;
    if (fs.existsSync(bin)) return bin;
  }
  return 'kaipai';
}

function runCommandAsync(bin, args, envExtra = {}, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const extraPath = '/Users/penggenhui/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin';
    const env = {
      ...process.env,
      PATH: `${extraPath}:${process.env.PATH || ''}`,
      ...envExtra,
    };
    const child = spawn(bin, args, { env });
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        child.kill('SIGTERM');
        resolve({ code: -1, stdout, stderr: `${stderr}\n[timeout after ${timeoutMs}ms]`, timedOut: true });
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: err.message, spawnError: true });
      }
    });
    child.on('close', (code) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      }
    });
  });
}

function extractUrlFromShareText(text) {
  if (!text) return '';
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  return match ? match[0].replace(/[，。！？、；：）》】]+$/, '') : text.trim();
}

function joinUrl(base, endpointPath) {
  if (/^https?:\/\//i.test(endpointPath)) return endpointPath;
  const cleanBase = (base || '').replace(/\/+$/, '');
  const cleanPath = (endpointPath || '').startsWith('/') ? endpointPath : `/${endpointPath}`;
  return `${cleanBase}${cleanPath}`;
}

function resolveLocalMediaPath(input) {
  if (!input) return null;
  if (input.startsWith('/uploads/')) {
    const p = path.join(UPLOADS_DIR, path.basename(input));
    return fs.existsSync(p) ? p : null;
  }
  if (input.startsWith('/outputs/')) {
    const p = path.join(OUTPUTS_DIR, path.basename(input));
    return fs.existsSync(p) ? p : null;
  }
  if (path.isAbsolute(input) && fs.existsSync(input)) {
    return input;
  }
  return null;
}

function findDeepValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = findDeepValue(val, keys);
      if (found) return found;
    }
  }
  return null;
}

function findDeepVideoUrl(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') {
    if (/^https?:\/\/.+\.(mp4|mov|webm)(\?|$)/i.test(obj)) return obj;
    return null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findDeepVideoUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof obj === 'object') {
    const priorityKeys = ['artifact_url', 'output_video_url', 'video_url', 'result_url', 'download_url', 'media_url', 'url'];
    for (const k of priorityKeys) {
      if (typeof obj[k] === 'string' && /^https?:\/\//i.test(obj[k])) {
        if (k !== 'url' || /\.(mp4|mov|webm)/i.test(obj[k])) return obj[k];
      }
    }
    for (const val of Object.values(obj)) {
      const found = findDeepVideoUrl(val);
      if (found) return found;
    }
  }
  return null;
}

function parseNdjson(text) {
  const items = [];
  for (const line of (text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      items.push({ raw: trimmed });
    }
  }
  return items;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/outputs', express.static(OUTPUTS_DIR));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '.bin';
    const safeBase = path.basename(file.originalname || 'file', ext).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 40);
    cb(null, `${Date.now()}_${safeBase}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ==================== 配置 API ====================
app.get('/api/config', (_req, res) => {
  const cfg = loadConfig();
  res.json({
    ok: true,
    config: cfg,
    status: {
      hzagent: Boolean(cfg.hzagentApiKey),
      deepseek: Boolean(cfg.deepseekApiKey),
      minimax: Boolean(cfg.minimaxApiKey),
      minimaxVoice: Boolean(cfg.minimaxDefaultVoiceId),
    },
  });
});

app.post('/api/config', (req, res) => {
  const next = saveConfig(req.body || {});
  res.json({
    ok: true,
    config: next,
    status: {
      hzagent: Boolean(next.hzagentApiKey),
      deepseek: Boolean(next.deepseekApiKey),
      minimax: Boolean(next.minimaxApiKey),
      minimaxVoice: Boolean(next.minimaxDefaultVoiceId),
    },
  });
});

// ==================== 通用文件上传 ====================
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: '未收到上传文件' });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  if (req.body?.setAsDefaultAvatar === 'true') {
    saveConfig({
      defaultAvatarVideoUrl: fileUrl,
      defaultAvatarVideoName: req.file.originalname,
    });
  }
  res.json({
    ok: true,
    url: fileUrl,
    localPath: req.file.path,
    originalName: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
  });
});

// ==================== 模块一：提取短视频文案 ====================
app.post('/api/module1/extract', async (req, res) => {
  const cfg = loadConfig();
  const rawInput = (req.body?.url || '').trim();
  if (!rawInput) {
    return res.status(400).json({ ok: false, error: '请输入短视频链接或分享文案' });
  }
  if (!cfg.hzagentApiKey) {
    return res.status(400).json({ ok: false, error: '请先在右上角「API 密钥与设置」中填写中转平台（ai.hzagent.cn）的 API Key' });
  }

  const parsedUrl = extractUrlFromShareText(rawInput);
  const endpoint = joinUrl(cfg.hzagentBaseUrl, cfg.hzagentExtractPath);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.hzagentApiKey}`,
      },
      body: JSON.stringify({
        videoUrl: parsedUrl,
        model: 'short-video-copy',
      }),
    });

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { rawText };
    }

    if (!response.ok || (data?.code !== undefined && data.code !== 200)) {
      return res.status(response.ok ? 400 : response.status).json({
        ok: false,
        error: data?.msg || data?.error?.message || data?.message || `中转平台返回 HTTP ${response.status}`,
        endpoint,
        parsedUrl,
        raw: data,
      });
    }

    const taskId = typeof data?.data === 'string'
      ? data.data
      : findDeepValue(data, ['task_id', 'taskId', 'id']);

    // 如果返回了 taskId，自动免费轮询直至 SUCCESS 或 FAIL（最多约 90 秒）
    if (taskId) {
      const taskBase = joinUrl(cfg.hzagentBaseUrl, cfg.hzagentExtractTaskPath || '/v1/video-copy/tasks');
      const pollUrl = `${taskBase.replace(/\/+$/, '')}/${encodeURIComponent(taskId)}?model=short-video-copy`;
      let lastPollData = null;

      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        const pollResp = await fetch(pollUrl, {
          method: 'GET',
          headers: { Authorization: `Bearer ${cfg.hzagentApiKey}` },
        });
        const pollText = await pollResp.text();
        try {
          lastPollData = JSON.parse(pollText);
        } catch {
          lastPollData = { rawText: pollText };
        }

        const schedule = String(lastPollData?.data?.schedule || '').toUpperCase();
        if (schedule === 'SUCCESS') {
          return res.json({
            ok: true,
            parsedUrl,
            endpoint,
            taskId,
            text: lastPollData?.data?.content || findDeepValue(lastPollData, ['content', 'text', 'copy']) || '',
            raw: lastPollData,
          });
        }
        if (schedule === 'FAIL' || schedule === 'FAILED') {
          return res.status(400).json({
            ok: false,
            error: lastPollData?.msg || lastPollData?.data?.message || '短视频文案提取任务失败',
            taskId,
            raw: lastPollData,
          });
        }
      }

      return res.json({
        ok: true,
        parsedUrl,
        endpoint,
        taskId,
        text: '',
        message: '任务仍在处理中，请稍后重试查询',
        raw: lastPollData || data,
      });
    }

    const extracted =
      findDeepValue(data, ['content', 'text', 'copy', 'transcript', 'caption', 'script']) ||
      data?.choices?.[0]?.message?.content ||
      '';

    return res.json({
      ok: true,
      parsedUrl,
      endpoint,
      text: extracted,
      taskId: '',
      raw: data,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: `请求中转平台失败: ${err.message}`,
      endpoint,
      parsedUrl,
    });
  }
});

// ==================== 模块二：DeepSeek 二创文案 ====================
app.post('/api/module2/rewrite', async (req, res) => {
  const cfg = loadConfig();
  const sourceText = (req.body?.sourceText || '').trim();
  const style = (req.body?.style || '通用短视频口播').trim();
  const wordCount = (req.body?.wordCount || '300字').trim();
  const extraRequirement = (req.body?.extraRequirement || '').trim();

  if (!sourceText) {
    return res.status(400).json({ ok: false, error: '请先输入或导入原文案' });
  }
  if (!cfg.deepseekApiKey) {
    return res.status(400).json({ ok: false, error: '请先在右上角「API 密钥与设置」中填写 DeepSeek API Key' });
  }

  const endpoint = joinUrl(cfg.deepseekBaseUrl, '/chat/completions');
  const systemPrompt = [
    '你是一位资深的短视频口播文案策划专家，擅长把参考文案二创为高完播、强吸引力的原创口播脚本。',
    '输出要求：',
    '1. 仅输出可直接用于口播配音的正文文案，不要输出“标题：”“开场：”等结构标签、不要使用 Markdown 符号或舞台提示；',
    '2. 保留核心价值观点，但重构开场钩子、表达节奏和金句，确保原创度高、自然口语化；',
    '3. 断句清晰，适合数字人语音合成直接朗读。',
  ].join('\n');

  const userPrompt = [
    `【目标风格】${style}`,
    `【目标字数】约 ${wordCount}`,
    extraRequirement ? `【补充要求】${extraRequirement}` : '',
    `【参考原文案】\n${sourceText}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.deepseekModel || 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: data?.error?.message || data?.message || `DeepSeek 返回 HTTP ${response.status}`,
        raw: data,
      });
    }

    const rewrittenText = data?.choices?.[0]?.message?.content?.trim() || '';
    return res.json({
      ok: true,
      model: data?.model || cfg.deepseekModel,
      text: rewrittenText,
      usage: data?.usage || null,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `调用 DeepSeek 失败: ${err.message}` });
  }
});

// ==================== 模块三：MiniMax 声音复刻 + 语音合成 ====================
app.get('/api/module3/voices', (_req, res) => {
  const cfg = loadConfig();
  res.json({
    ok: true,
    defaultVoiceId: cfg.minimaxDefaultVoiceId,
    clonedVoices: loadClonedVoices(),
    builtinVoices: BUILTIN_MINIMAX_VOICES,
  });
});

app.post('/api/module3/clone', upload.single('audio'), async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.minimaxApiKey) {
    return res.status(400).json({ ok: false, error: '请先在右上角「API 密钥与设置」中填写 MiniMax API Key' });
  }
  if (!req.file) {
    return res.status(400).json({ ok: false, error: '请先上传本地人声录音文件（支持 mp3 / wav / m4a，10秒~5分钟）' });
  }

  const voiceName = (req.body?.voiceName || '我的克隆声音').trim();
  const customVoiceId =
    (req.body?.voiceId || '').trim() ||
    `my_voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const previewText = (req.body?.previewText || '').trim();
  const setAsDefault = req.body?.setAsDefault !== 'false';

  try {
    // 1. 上传音频文件获取 file_id
    const uploadEndpoint = joinUrl(cfg.minimaxBaseUrl, '/v1/files/upload');
    const fileBuffer = fs.readFileSync(req.file.path);
    const formData = new FormData();
    formData.append('purpose', 'voice_clone');
    formData.append(
      'file',
      new Blob([fileBuffer], { type: req.file.mimetype || 'audio/mpeg' }),
      req.file.originalname || 'voice.mp3'
    );

    const uploadResp = await fetch(uploadEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.minimaxApiKey}` },
      body: formData,
    });
    const uploadData = await uploadResp.json();
    const fileId = uploadData?.file?.file_id || uploadData?.file_id;
    if (!uploadResp.ok || !fileId) {
      return res.status(uploadResp.ok ? 400 : uploadResp.status).json({
        ok: false,
        error: uploadData?.base_resp?.status_msg || uploadData?.error?.message || 'MiniMax 上传音频文件失败',
        raw: uploadData,
      });
    }

    // 2. 调用声音复刻接口绑定 voice_id
    const cloneEndpoint = joinUrl(cfg.minimaxBaseUrl, '/v1/voice_clone');
    const clonePayload = {
      file_id: fileId,
      voice_id: customVoiceId,
      need_noise_reduction: true,
    };
    if (previewText) {
      clonePayload.text = previewText;
      clonePayload.model = cfg.minimaxTtsModel || 'speech-2.8-hd';
    }

    const cloneResp = await fetch(cloneEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.minimaxApiKey}`,
      },
      body: JSON.stringify(clonePayload),
    });
    const cloneData = await cloneResp.json();
    const statusCode = cloneData?.base_resp?.status_code;
    if (!cloneResp.ok || (statusCode !== undefined && statusCode !== 0)) {
      return res.status(cloneResp.ok ? 400 : cloneResp.status).json({
        ok: false,
        error: cloneData?.base_resp?.status_msg || cloneData?.error?.message || 'MiniMax 声音复刻失败',
        raw: cloneData,
      });
    }

    const savedList = saveClonedVoice({
      voice_id: customVoiceId,
      name: voiceName,
      file_id: fileId,
      sourceAudioUrl: `/uploads/${req.file.filename}`,
      demoAudioUrl: cloneData?.demo_audio || '',
    });

    if (setAsDefault) {
      saveConfig({ minimaxDefaultVoiceId: customVoiceId });
    }

    return res.json({
      ok: true,
      voiceId: customVoiceId,
      voiceName,
      fileId,
      demoAudioUrl: cloneData?.demo_audio || '',
      clonedVoices: savedList,
      raw: cloneData,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `MiniMax 声音复刻异常: ${err.message}` });
  }
});

app.post('/api/module3/tts', async (req, res) => {
  const cfg = loadConfig();
  const text = (req.body?.text || '').trim();
  const voiceId = (req.body?.voiceId || cfg.minimaxDefaultVoiceId || '').trim();
  const speed = Number(req.body?.speed ?? 1.0);
  const model = (req.body?.model || cfg.minimaxTtsModel || 'speech-2.8-hd').trim();

  if (!text) {
    return res.status(400).json({ ok: false, error: '请先输入或导入要合成的文案' });
  }
  if (!cfg.minimaxApiKey) {
    return res.status(400).json({ ok: false, error: '请先在右上角「API 密钥与设置」中填写 MiniMax API Key' });
  }
  if (!voiceId) {
    return res.status(400).json({ ok: false, error: '请先选择音色，或在「声音复刻」中生成/在设置中填写默认 MiniMax 音色 ID' });
  }

  const endpoint = joinUrl(cfg.minimaxBaseUrl, '/v1/t2a_v2');
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.minimaxApiKey}`,
      },
      body: JSON.stringify({
        model,
        text,
        stream: false,
        output_format: 'hex',
        voice_setting: {
          voice_id: voiceId,
          speed: Number.isFinite(speed) ? Math.min(2.0, Math.max(0.5, speed)) : 1.0,
          vol: 1.0,
          pitch: 0,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
          channel: 1,
        },
      }),
    });

    const data = await response.json();
    const statusCode = data?.base_resp?.status_code;
    if (!response.ok || (statusCode !== undefined && statusCode !== 0)) {
      return res.status(response.ok ? 400 : response.status).json({
        ok: false,
        error: data?.base_resp?.status_msg || data?.error?.message || `MiniMax 语音合成失败 (HTTP ${response.status})`,
        raw: data,
      });
    }

    const audioHex = data?.data?.audio;
    if (!audioHex) {
      return res.status(500).json({ ok: false, error: 'MiniMax 未返回音频数据', raw: data });
    }

    const filename = `tts_${Date.now()}.mp3`;
    const outPath = path.join(OUTPUTS_DIR, filename);
    if (/^https?:\/\//i.test(audioHex)) {
      const audioResp = await fetch(audioHex);
      const arrBuf = await audioResp.arrayBuffer();
      fs.writeFileSync(outPath, Buffer.from(arrBuf));
    } else {
      fs.writeFileSync(outPath, Buffer.from(audioHex, 'hex'));
    }

    return res.json({
      ok: true,
      voiceId,
      model,
      taskId: data?.trace_id || `tts_${Date.now()}`,
      audioUrl: `/outputs/${filename}`,
      remoteAudioUrl: /^https?:\/\//i.test(audioHex) ? audioHex : '',
      localPath: outPath,
      extraInfo: data?.extra_info || null,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `调用 MiniMax 语音合成失败: ${err.message}` });
  }
});

async function ensurePublicMediaUrl(input) {
  if (!input) return input;
  const localPath = resolveLocalMediaPath(input) ||
    (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/(uploads|outputs)\/.+)$/i.test(input)
      ? resolveLocalMediaPath(input.replace(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i, ''))
      : null);
  if (!localPath) return input;

  const buf = fs.readFileSync(localPath);
  const ext = path.extname(localPath).toLowerCase();
  const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : ext === '.mp4' ? 'video/mp4' : 'application/octet-stream';
  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('time', '1h');
  fd.append('fileToUpload', new Blob([buf], { type: mime }), path.basename(localPath));
  const resp = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', { method: 'POST', body: fd });
  const text = (await resp.text()).trim();
  if (!resp.ok || !/^https?:\/\//i.test(text)) {
    throw new Error(`本地文件转公网链接失败: ${text || resp.status}`);
  }
  return text;
}

// ==================== 模块四：数字人对口型 (avatar-lipsync) ====================
app.post('/api/module4/lipsync', async (req, res) => {
  const cfg = loadConfig();
  const taskName = (req.body?.taskName || '口播数字人任务').trim();
  const rawVideoUrl = (req.body?.videoUrl || cfg.defaultAvatarVideoUrl || '').trim();
  const rawAudioUrl = (req.body?.audioUrl || '').trim();

  if (!cfg.hzagentApiKey) {
    return res.status(400).json({ ok: false, error: '请先在右上角「API 密钥与设置」中填写中转平台（ai.hzagent.cn）的 API Key' });
  }
  if (!rawVideoUrl) {
    return res.status(400).json({ ok: false, error: '请提供人物视频公网链接或先上传本地人物视频' });
  }
  if (!rawAudioUrl) {
    return res.status(400).json({ ok: false, error: '请提供配音音频链接（可一键导入模块三配音）' });
  }

  const endpoint = joinUrl(cfg.hzagentBaseUrl, cfg.hzagentLipsyncPath);

  // 注意：遵循文档要求，单次提交，绝不自动循环重试以免浪费积分
  try {
    const [videoUrl, audioUrl] = await Promise.all([
      ensurePublicMediaUrl(rawVideoUrl),
      ensurePublicMediaUrl(rawAudioUrl),
    ]);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.hzagentApiKey}`,
      },
      body: JSON.stringify({
        videoName: taskName,
        audioUrl,
        videoUrl,
      }),
    });

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { rawText };
    }

    if (!response.ok || (data?.code !== undefined && data.code !== 200)) {
      return res.status(response.ok ? 400 : response.status).json({
        ok: false,
        error: data?.msg || data?.error?.message || data?.message || `数字人接口返回 HTTP ${response.status}`,
        endpoint,
        raw: data,
      });
    }

    const taskId = typeof data?.data === 'string'
      ? data.data
      : findDeepValue(data, ['task_id', 'taskId', 'id']) || '';

    return res.json({
      ok: true,
      endpoint,
      taskId,
      status: findDeepValue(data, ['status', 'state']) || 'submitted',
      videoUrl: findDeepVideoUrl(data) || '',
      raw: data,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `提交数字人任务失败: ${err.message}`, endpoint });
  }
});

app.get('/api/module4/task/:taskId', async (req, res) => {
  const cfg = loadConfig();
  const taskId = (req.params.taskId || '').trim();
  if (!taskId) return res.status(400).json({ ok: false, error: '请提供 task_id' });
  if (!cfg.hzagentApiKey) {
    return res.status(400).json({ ok: false, error: '请先配置中转平台（ai.hzagent.cn）API Key' });
  }

  const endpoint = joinUrl(cfg.hzagentBaseUrl, `${cfg.hzagentTaskPath.replace(/\/+$/, '')}/${encodeURIComponent(taskId)}`);
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.hzagentApiKey}` },
    });
    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { rawText };
    }

    if (!response.ok || (data?.code !== undefined && data.code !== 200)) {
      return res.status(response.ok ? 400 : response.status).json({
        ok: false,
        error: data?.msg || data?.error?.message || data?.message || `查询任务失败 (HTTP ${response.status})`,
        endpoint,
        raw: data,
      });
    }

    const statusMap = { 0: '排队中', 1: '生成中', 2: '已完成', 3: '失败' };
    const rawStatus = data?.data?.status;
    const statusLabel = typeof rawStatus === 'number'
      ? (statusMap[rawStatus] || String(rawStatus))
      : (findDeepValue(data, ['status', 'state']) || 'unknown');

    const resultList = Array.isArray(data?.data?.result) ? data.data.result : [];
    const remoteVideoUrl = resultList[0] || (typeof data?.data?.result === 'string' ? data.data.result : '');
    let finalVideoUrl = remoteVideoUrl;

    if (remoteVideoUrl) {
      const cached = await cacheRemoteVideoLocally(remoteVideoUrl, 'digital_human');
      if (cached) {
        finalVideoUrl = cached.url;
        saveVideoRecord({
          id: `dh_${taskId}`,
          title: data?.data?.request?.videoName || `数字人视频 (${taskId.slice(-6)})`,
          source: '数字人视频',
          url: cached.url,
          remoteUrl: remoteVideoUrl,
          size: cached.size,
        });
      }
    }

    return res.json({
      ok: true,
      taskId,
      status: statusLabel,
      videoUrl: finalVideoUrl,
      remoteVideoUrl,
      raw: data,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `查询数字人任务异常: ${err.message}`, endpoint });
  }
});

// ==================== 模块四 B：不对口型 · 本地画面直接替换配音（0 积分免费） ====================
app.post('/api/module4/local-mux', async (req, res) => {
  const cfg = loadConfig();
  const taskName = (req.body?.taskName || '画面配音视频').trim();
  const rawVideoUrl = (req.body?.videoUrl || cfg.defaultAvatarVideoUrl || '').trim();
  const rawAudioUrl = (req.body?.audioUrl || '').trim();

  if (!rawVideoUrl) {
    return res.status(400).json({ ok: false, error: '请先提供底板视频（可在模块 4 上传本地 MP4）' });
  }
  if (!rawAudioUrl) {
    return res.status(400).json({ ok: false, error: '请先提供配音音频（可一键导入模块 3 配音）' });
  }

  const resolveOrDownload = async (input, extFallback) => {
    const local = resolveLocalMediaPath(input) ||
      (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/(uploads|outputs)\/.+)$/i.test(input)
        ? resolveLocalMediaPath(input.replace(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i, ''))
        : null);
    if (local) return local;
    if (/^https?:\/\//i.test(input)) {
      const resp = await fetch(input);
      if (!resp.ok) throw new Error(`下载素材失败 (HTTP ${resp.status})`);
      const p = path.join(OUTPUTS_DIR, `mux_src_${Date.now()}${extFallback}`);
      fs.writeFileSync(p, Buffer.from(await resp.arrayBuffer()));
      return p;
    }
    return null;
  };

  try {
    const videoPath = await resolveOrDownload(rawVideoUrl, '.mp4');
    const audioPath = await resolveOrDownload(rawAudioUrl, '.mp3');
    if (!videoPath || !audioPath) {
      return res.status(400).json({ ok: false, error: '找不到有效的本地视频或音频文件' });
    }

    const outFilename = `voiceover_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUTS_DIR, outFilename);
    const args = [
      '-y',
      '-stream_loop', '-1',
      '-i', videoPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-shortest',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '21',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outPath,
    ];

    const run = await runCommandAsync('/opt/homebrew/bin/ffmpeg', args, {}, 120000);
    if (run.code !== 0 || !fs.existsSync(outPath)) {
      return res.status(500).json({ ok: false, error: `本地合成失败: ${run.stderr.slice(-300)}` });
    }

    const stat = fs.statSync(outPath);
    const videoUrl = `/outputs/${outFilename}`;
    saveVideoRecord({
      id: `vo_${Date.now()}`,
      title: `${taskName}（免对口型）`,
      source: '免费配音视频',
      url: videoUrl,
      remoteUrl: '',
      size: stat.size,
    });

    return res.json({
      ok: true,
      videoUrl,
      size: stat.size,
      mode: 'local-mux',
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `免对口型合成异常: ${err.message}` });
  }
});

// ==================== 模块五：开拍 CLI 一键剪辑 ====================
app.get('/api/module5/kaipai/status', async (_req, res) => {
  const cfg = loadConfig();
  const bin = resolveKaipaiBin(cfg);
  const envExtra = cfg.kaipaiAccessKey ? { KAIPAI_ACCESS_KEY: cfg.kaipaiAccessKey } : {};

  const check = await runCommandAsync(bin, ['auth', 'status', '--check'], envExtra, 20000);
  if (check.spawnError) {
    return res.json({
      ok: true,
      installed: false,
      connected: false,
      binPath: bin,
      message: '未检测到开拍 CLI，请运行 npm install -g meitu-kaipai-cli',
      raw: check.stderr,
    });
  }

  const combined = `${check.stdout}\n${check.stderr}`;
  const connected = check.code === 0 && !/disconnected|not logged|unauthenticated|未登录/i.test(combined);
  return res.json({
    ok: true,
    installed: true,
    connected,
    binPath: bin,
    hasAccessKey: Boolean(cfg.kaipaiAccessKey),
    stdout: check.stdout.trim(),
    stderr: check.stderr.trim(),
  });
});

app.get('/api/module5/kaipai/history', async (_req, res) => {
  const cfg = loadConfig();
  const bin = resolveKaipaiBin(cfg);
  const envExtra = cfg.kaipaiAccessKey ? { KAIPAI_ACCESS_KEY: cfg.kaipaiAccessKey } : {};
  const result = await runCommandAsync(bin, ['history'], envExtra, 25000);
  return res.json({
    ok: result.code === 0,
    code: result.code,
    events: parseNdjson(result.stdout),
    stderr: result.stderr.trim(),
  });
});

app.post('/api/module5/kaipai/edit', async (req, res) => {
  const cfg = loadConfig();
  const bin = resolveKaipaiBin(cfg);
  const mode = (req.body?.mode || 'subtitle').trim();
  const videoSource = (req.body?.videoSource || '').trim();
  const prompt = (req.body?.prompt || '').trim();
  const materialId = (req.body?.materialId || '').trim();

  if (!videoSource && mode !== 'chat') {
    return res.status(400).json({ ok: false, error: '请先提供视频源（可一键导入模块四视频，或上传本地 MP4）' });
  }

  const envExtra = cfg.kaipaiAccessKey ? { KAIPAI_ACCESS_KEY: cfg.kaipaiAccessKey } : {};
  let localPath = resolveLocalMediaPath(videoSource);
  let args = [];

  try {
    if (mode === 'subtitle') {
      args = ['subtitle'];
      if (localPath) {
        args.push('--video-file', localPath);
      } else {
        args.push('--video-url', videoSource);
      }
      if (materialId) args.push('--subtitle-material-id', materialId);
    } else if (mode === 'smartedit') {
      // smartedit 需要本地视频文件；若是公网 URL 则先下载到本地 outputs/
      if (!localPath && /^https?:\/\//i.test(videoSource)) {
        const dlResp = await fetch(videoSource);
        if (!dlResp.ok) {
          return res.status(400).json({ ok: false, error: `下载源视频失败 (HTTP ${dlResp.status})` });
        }
        const dlName = `kaipai_src_${Date.now()}.mp4`;
        localPath = path.join(OUTPUTS_DIR, dlName);
        fs.writeFileSync(localPath, Buffer.from(await dlResp.arrayBuffer()));
      }
      if (!localPath) {
        return res.status(400).json({ ok: false, error: '智能成片包装（smartedit）需要有效的本地视频文件或可下载的视频 URL' });
      }
      args = ['smartedit', '--video-file', localPath];
      if (materialId) args.push('--template-material-id', materialId);
    } else if (mode === 'chat') {
      const chatPrompt = prompt || '请帮我对这段口播视频进行一键智能剪辑、添加动态字幕与背景音乐';
      args = ['chat', '-p', chatPrompt];
    } else {
      return res.status(400).json({ ok: false, error: `不支持的剪辑模式: ${mode}` });
    }

    const result = await runCommandAsync(bin, args, envExtra, 300000);
    const events = parseNdjson(result.stdout);
    const outputVideoUrl = findDeepVideoUrl(events) || '';
    const sessionId = findDeepValue(events, ['session_id', 'room_id', 'sessionId', 'roomId']) || '';
    const taskId = findDeepValue(events, ['task_id', 'taskId']) || '';

    if (result.code !== 0) {
      return res.status(500).json({
        ok: false,
        error: result.stderr.trim() || `开拍 CLI 退出码 ${result.code}（请确认已执行 kaipai auth login 或已配置 KAIPAI_ACCESS_KEY）`,
        command: `${bin} ${args.join(' ')}`,
        events,
        stderr: result.stderr.trim(),
      });
    }

    let finalOutputUrl = outputVideoUrl;
    if (outputVideoUrl) {
      const modeLabel = mode === 'smartedit' ? '开拍智能成片' : mode === 'subtitle' ? '开拍动态字幕' : '开拍成片';
      const cached = await cacheRemoteVideoLocally(outputVideoUrl, `kaipai_${mode}`);
      if (cached) {
        finalOutputUrl = cached.url;
        saveVideoRecord({
          id: taskId ? `kp_${taskId}` : `kp_${Date.now()}`,
          title: `${modeLabel} ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
          source: '开拍成片',
          url: cached.url,
          remoteUrl: outputVideoUrl,
          size: cached.size,
        });
      }
    }

    return res.json({
      ok: true,
      mode,
      command: `${bin} ${args.join(' ')}`,
      outputVideoUrl: finalOutputUrl,
      remoteVideoUrl: outputVideoUrl,
      sessionId,
      taskId,
      events,
      stderr: result.stderr.trim(),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `执行开拍 CLI 失败: ${err.message}` });
  }
});

const JIANYING_DRAFTS_DIR = '/Users/penggenhui/Movies/JianyingPro/User Data/Projects/com.lveditor.draft';

function resolveCapcutBin() {
  const candidates = [
    '/Users/penggenhui/.hermes/node/bin/capcut',
    '/usr/local/bin/capcut',
    '/opt/homebrew/bin/capcut',
    'capcut',
  ];
  for (const bin of candidates) {
    if (bin === 'capcut') return bin;
    if (fs.existsSync(bin)) return bin;
  }
  return 'capcut';
}

// ==================== 模块五 B：capcut-cli 免费一键生成剪映草稿 ====================
app.get('/api/module5/capcut/status', (_req, res) => {
  const bin = resolveCapcutBin();
  const installed = bin === 'capcut' ? false : fs.existsSync(bin);
  const draftsDirExists = fs.existsSync(JIANYING_DRAFTS_DIR);
  res.json({
    ok: true,
    installed,
    binPath: bin,
    draftsDir: JIANYING_DRAFTS_DIR,
    draftsDirExists,
  });
});

function formatSrtTime(sec) {
  const msTotal = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(msTotal / 3600000);
  const m = Math.floor((msTotal % 3600000) / 60000);
  const s = Math.floor((msTotal % 60000) / 1000);
  const ms = msTotal % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function buildSrtFromScript(scriptText, totalDurationSec) {
  const cleaned = (scriptText || '').replace(/\r/g, '\n').trim();
  if (!cleaned || !totalDurationSec || totalDurationSec <= 0) return '';

  // 按中文标点切分为自然口播短句，每条字幕控制在约 14 字以内
  const rawChunks = cleaned
    .split(/[。！？!?\n；;，,、]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const cues = [];
  for (const chunk of rawChunks) {
    if (chunk.length <= 15) {
      cues.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += 14) {
        cues.push(chunk.slice(i, i + 14));
      }
    }
  }
  if (!cues.length) return '';

  const totalChars = cues.reduce((sum, c) => sum + Math.max(1, c.length), 0);
  const usableDuration = Math.max(0.5, totalDurationSec - 0.15);
  let cursor = 0.08;
  const lines = [];

  cues.forEach((cue, idx) => {
    const share = (Math.max(1, cue.length) / totalChars) * usableDuration;
    const start = cursor;
    const end = idx === cues.length - 1 ? Math.max(start + 0.3, totalDurationSec - 0.05) : Math.min(totalDurationSec, start + share);
    cursor = end;
    lines.push(`${idx + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${cue}\n`);
  });

  return lines.join('\n');
}

async function probeMediaDurationSec(localPath) {
  const res = await runCommandAsync('/opt/homebrew/bin/ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    localPath,
  ], {}, 10000);
  const val = parseFloat((res.stdout || '').trim());
  return Number.isFinite(val) && val > 0 ? val : 0;
}

app.post('/api/module5/capcut/draft', async (req, res) => {
  const videoSource = (req.body?.videoSource || '').trim();
  const rawName = (req.body?.draftName || '').trim() || `数字人草稿_${new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '')}`;
  const baseSafeName = rawName.replace(/[\/\\:*?"<>|]/g, '_');
  let safeName = baseSafeName;
  let suffix = 2;
  while (fs.existsSync(path.join(JIANYING_DRAFTS_DIR, safeName))) {
    safeName = `${baseSafeName}_${suffix++}`;
  }
  const ratio = (req.body?.ratio || '9:16').trim();
  const openApp = Boolean(req.body?.openApp);
  const autoSubtitles = req.body?.autoSubtitles !== false;
  const scriptText = (req.body?.scriptText || '').trim();
  const bgmUrl = (req.body?.bgmUrl || '').trim();
  const subtitleColor = (req.body?.subtitleColor || '#FFD800').trim();
  const subtitleFontSize = Number(req.body?.subtitleFontSize || 11);

  if (!videoSource) {
    return res.status(400).json({ ok: false, error: '请先在上方导入模块 4 视频或上传本地 MP4' });
  }

  let localPath = resolveLocalMediaPath(videoSource);
  if (!localPath && /^https?:\/\//i.test(videoSource)) {
    try {
      const dlResp = await fetch(videoSource);
      if (!dlResp.ok) throw new Error(`HTTP ${dlResp.status}`);
      const dlName = `jianying_src_${Date.now()}.mp4`;
      localPath = path.join(OUTPUTS_DIR, dlName);
      fs.writeFileSync(localPath, Buffer.from(await dlResp.arrayBuffer()));
    } catch (err) {
      return res.status(400).json({ ok: false, error: `下载视频失败: ${err.message}` });
    }
  }
  if (!localPath) {
    return res.status(400).json({ ok: false, error: '找不到有效的本地视频文件' });
  }

  const bin = resolveCapcutBin();
  const args = [
    'quickstart',
    safeName,
    '--video',
    localPath,
    '--drafts',
    JIANYING_DRAFTS_DIR,
    '--template',
    'bundled',
    '--ratio',
    ratio,
    '--jianying',
  ];

  // 可选：附加背景音乐 BGM
  const bgmLocalPath = resolveLocalMediaPath(bgmUrl);
  if (bgmLocalPath) {
    args.push('--audio', bgmLocalPath);
  }

  const result = await runCommandAsync(bin, args, {}, 60000);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = { stdout: result.stdout.trim() };
  }

  if (result.code !== 0) {
    return res.status(500).json({
      ok: false,
      error: parsed?.error || result.stderr.trim() || `capcut-cli 退出码 ${result.code}`,
      raw: parsed,
    });
  }

  const draftPath = path.join(JIANYING_DRAFTS_DIR, safeName);
  let captionsAdded = 0;
  let srtResult = null;
  let srtPath = '';

  // 自动根据文案生成 SRT，并使用开拍同款亮黄字+黑描边+阴影样式导入剪映字幕轨
  if (autoSubtitles && scriptText) {
    const durationSec = await probeMediaDurationSec(localPath);
    const srtContent = buildSrtFromScript(scriptText, durationSec);
    if (srtContent) {
      srtPath = path.join(OUTPUTS_DIR, `sub_${Date.now()}.srt`);
      fs.writeFileSync(srtPath, srtContent, 'utf-8');
      const srtArgs = [
        'import-srt',
        draftPath,
        srtPath,
        '--color', subtitleColor,
        '--font-size', String(Number.isFinite(subtitleFontSize) ? subtitleFontSize : 11),
        '--align', '1',
        '--y', '-0.62',
        '--border-color', '#000000',
        '--border-width', '0.08',
        '--border-alpha', '1',
        '--shadow',
        '--shadow-color', '#000000',
        '--shadow-alpha', '0.65',
        '--jianying',
        '--force-write',
      ];
      const srtRun = await runCommandAsync(bin, srtArgs, {}, 30000);
      try {
        srtResult = JSON.parse(srtRun.stdout);
        captionsAdded = srtResult?.cues || srtResult?.added || srtResult?.count || srtResult?.segments?.length || 0;
      } catch {
        srtResult = { stdout: srtRun.stdout.trim(), stderr: srtRun.stderr.trim() };
      }
    }
  }

  // 同时免费渲染出带黄字黑边字幕的 1080p 成片 MP4，自动加入模块 6 历史成片列表并直接预览
  let outputVideoUrl = '';
  let renderError = '';
  if (srtPath && fs.existsSync(srtPath)) {
    const outFilename = `jianying_${Date.now()}.mp4`;
    const outFilePath = path.join(OUTPUTS_DIR, outFilename);
    const burnScript = path.join(__dirname, 'scripts', 'burn_subtitles.py');
    const pyArgs = [
      burnScript,
      '--video', localPath,
      '--srt', srtPath,
      '--out', outFilePath,
      '--color', subtitleColor,
    ];
    if (bgmLocalPath) {
      pyArgs.push('--bgm', bgmLocalPath);
    }
    const burnRun = await runCommandAsync('/usr/bin/python3', pyArgs, {}, 180000);
    if (burnRun.code === 0 && fs.existsSync(outFilePath)) {
      outputVideoUrl = `/outputs/${outFilename}`;
      const stat = fs.statSync(outFilePath);
      saveVideoRecord({
        id: `jy_${Date.now()}`,
        title: `${safeName}`,
        source: '剪映成片',
        url: outputVideoUrl,
        remoteUrl: '',
        size: stat.size,
      });
    } else {
      renderError = burnRun.stderr.trim() || `burn_subtitles exited with ${burnRun.code}`;
    }
  }

  if (openApp) {
    await runCommandAsync('open', ['-a', 'VideoFusion-macOS'], {}, 5000);
  }

  return res.json({
    ok: true,
    draftName: safeName,
    draftPath,
    subtitleColor,
    captionsAdded,
    audioAdded: Boolean(parsed?.added?.audio),
    outputVideoUrl,
    renderError,
    result: parsed,
    srtResult,
  });
});

app.post('/api/module5/capcut/open', async (_req, res) => {
  const result = await runCommandAsync('open', ['-a', 'VideoFusion-macOS'], {}, 5000);
  res.json({ ok: result.code === 0, stderr: result.stderr.trim() });
});

// ==================== 模块六：历史成片列表 ====================
app.get('/api/videos', (_req, res) => {
  res.json({ ok: true, videos: loadVideos() });
});

app.delete('/api/videos/:id', (req, res) => {
  const id = (req.params.id || '').trim();
  const list = loadVideos();
  const next = list.filter((v) => v.id !== id);
  fs.writeFileSync(VIDEOS_FILE, JSON.stringify(next, null, 2), 'utf-8');
  res.json({ ok: true, videos: next });
});

const PORT = Number(process.env.PORT || 3456);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 数字人智能体工作台已启动: http://127.0.0.1:${PORT}\n`);
});
