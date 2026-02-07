// 后端服务器 - 用于存储和共享图片数据（支持创作者/访客权限）
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
let sharp;
try { sharp = require('sharp'); } catch (e) { console.warn('sharp 未安装，缩略图功能不可用'); }

const app = express();
const PORT = process.env.PORT || 3000;

// 创作者密钥（部署时必须设置环境变量 CREATOR_SECRET，否则仅本地可全权限）
const CREATOR_SECRET = process.env.CREATOR_SECRET || '';

// 中间件
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 权限解析中间件：从请求头解析创作者/访客身份
app.use((req, res, next) => {
    const creatorToken = req.headers['x-creator-token'] || (req.body && req.body._creatorToken);
    const visitorId = req.headers['x-visitor-id'] || (req.body && req.body._visitorId);
    req.isCreator = !!(CREATOR_SECRET && creatorToken === CREATOR_SECRET);
    req.visitorId = visitorId || null;
    next();
});

// 数据目录：支持环境变量 DATA_DIR 或 RAILWAY_VOLUME_MOUNT_PATH，便于挂载持久化卷
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');

async function ensureDirectories() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(IMAGES_DIR, { recursive: true });
        await fs.mkdir(THUMBS_DIR, { recursive: true });
    } catch (error) {
        console.error('创建目录失败:', error);
    }
}

// 配置multer用于文件上传
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, IMAGES_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(7)}-${file.originalname}`;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB限制
});

// 数据文件路径
const IMAGES_DB = path.join(DATA_DIR, 'images.json');
const TAGS_DB = path.join(DATA_DIR, 'tags.json');
const COMPLETIONS_DB = path.join(DATA_DIR, 'completions.json');

// ===== 缩略图生成 =====
const THUMB_MAX_SIZE = 400; // 缩略图最大边长（px）
const THUMB_QUALITY = 75;   // JPEG 压缩质量

async function generateThumbnail(sourceFilePath, thumbFilename) {
    if (!sharp) return null;
    try {
        const thumbPath = path.join(THUMBS_DIR, thumbFilename);
        await sharp(sourceFilePath)
            .resize(THUMB_MAX_SIZE, THUMB_MAX_SIZE, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: THUMB_QUALITY })
            .toFile(thumbPath);
        return `/thumbs/${thumbFilename}`;
    } catch (err) {
        console.warn('生成缩略图失败:', err.message);
        return null;
    }
}

// ===== 数据读写 =====
async function readCompletions() {
    try {
        const data = await fs.readFile(COMPLETIONS_DB, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return {};
    }
}

async function saveCompletions(data) {
    await fs.writeFile(COMPLETIONS_DB, JSON.stringify(data, null, 2), 'utf8');
}

async function readImages() {
    try {
        const data = await fs.readFile(IMAGES_DB, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

async function readTags() {
    try {
        const data = await fs.readFile(TAGS_DB, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

async function saveImages(images) {
    await fs.writeFile(IMAGES_DB, JSON.stringify(images, null, 2), 'utf8');
}

async function saveTags(tags) {
    await fs.writeFile(TAGS_DB, JSON.stringify(tags, null, 2), 'utf8');
}

// ===== API 路由 =====

// 获取所有图片（不返回 dataUrl，避免响应体过大）
app.get('/api/images', async (req, res) => {
    try {
        const images = await readImages();
        const list = images.map(img => {
            const { dataUrl, ...rest } = img;
            return {
                ...rest,
                uploadedBy: img.uploadedBy || 'creator',
                visitorId: img.visitorId || null
            };
        });
        res.json(list);
    } catch (error) {
        res.status(500).json({ error: '获取图片失败' });
    }
});

// 上传图片（从 base64）
app.post('/api/images', async (req, res) => {
    try {
        const { name, dataUrl, tags, keywords } = req.body;
        
        if (!dataUrl || !dataUrl.startsWith('data:image/')) {
            return res.status(400).json({ error: '无效的图片数据' });
        }
        
        if (!req.isCreator && !req.visitorId) {
            return res.status(400).json({ error: '访客上传请提供 X-Visitor-Id' });
        }
        
        // 将 base64 转换为文件
        const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        
        const mimeMatch = dataUrl.match(/data:image\/(\w+);base64/);
        const ext = mimeMatch ? mimeMatch[1] : 'png';
        const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`;
        const filepath = path.join(IMAGES_DIR, filename);
        
        await fs.writeFile(filepath, buffer);
        
        // 生成缩略图
        const thumbFilename = `thumb_${filename.replace(/\.\w+$/, '.jpg')}`;
        const thumbnailUrl = await generateThumbnail(filepath, thumbFilename);
        
        // 创建图片记录（不再存储 dataUrl，减小 images.json 体积）
        const imageData = {
            id: Date.now() + Math.random(),
            name: name || `图片_${Date.now()}`,
            filename: filename,
            url: `/images/${filename}`,
            thumbnailUrl: thumbnailUrl || `/images/${filename}`,
            tags: tags || [],
            keywords: keywords || [],
            timestamp: Date.now(),
            uploadedBy: req.isCreator ? 'creator' : 'visitor',
            visitorId: req.isCreator ? null : (req.visitorId || null)
        };
        
        const images = await readImages();
        images.push(imageData);
        await saveImages(images);
        
        res.json(imageData);
    } catch (error) {
        console.error('上传图片失败:', error);
        res.status(500).json({ error: '上传图片失败' });
    }
});

// 删除图片
app.delete('/api/images/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const images = await readImages();
        const image = images.find(img => img.id == id);
        
        if (!image) {
            return res.status(404).json({ error: '图片不存在' });
        }
        
        const uploadedBy = image.uploadedBy || 'creator';
        const canDelete = req.isCreator ||
            (uploadedBy === 'visitor' && image.visitorId && image.visitorId === req.visitorId);
        
        if (!canDelete) {
            return res.status(403).json({ error: '无权删除该图片（仅创作者可删除创作者上传的内容）' });
        }
        
        // 删除原图
        try {
            await fs.unlink(path.join(IMAGES_DIR, image.filename));
        } catch (error) { console.warn('删除原图失败:', error.message); }
        
        // 删除缩略图
        if (image.thumbnailUrl) {
            try {
                const thumbName = path.basename(image.thumbnailUrl);
                await fs.unlink(path.join(THUMBS_DIR, thumbName));
            } catch (error) { /* 忽略 */ }
        }
        
        const filtered = images.filter(img => img.id != id);
        await saveImages(filtered);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: '删除图片失败' });
    }
});

// 批量删除
app.post('/api/images/delete-multiple', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids)) {
            return res.status(400).json({ error: '无效的ID列表' });
        }
        
        const images = await readImages();
        const allowedToDelete = images.filter(img => {
            if (!ids.some(id => String(id) === String(img.id))) return false;
            const uploadedBy = img.uploadedBy || 'creator';
            return req.isCreator ||
                (uploadedBy === 'visitor' && img.visitorId && img.visitorId === req.visitorId);
        });
        
        for (const image of allowedToDelete) {
            try { await fs.unlink(path.join(IMAGES_DIR, image.filename)); } catch (e) {}
            if (image.thumbnailUrl) {
                try { await fs.unlink(path.join(THUMBS_DIR, path.basename(image.thumbnailUrl))); } catch (e) {}
            }
        }
        
        const allowedIds = allowedToDelete.map(img => img.id);
        const filtered = images.filter(img => !allowedIds.includes(img.id));
        await saveImages(filtered);
        
        res.json({ success: true, deleted: allowedToDelete.length });
    } catch (error) {
        res.status(500).json({ error: '批量删除失败' });
    }
});

// 获取标签
app.get('/api/tags', async (req, res) => {
    try {
        const tags = await readTags();
        res.json(tags);
    } catch (error) {
        res.status(500).json({ error: '获取标签失败' });
    }
});

// 保存标签（仅创作者）
app.post('/api/tags', async (req, res) => {
    try {
        if (!req.isCreator) {
            return res.status(403).json({ error: '仅创作者可管理标签' });
        }
        const tags = req.body;
        await saveTags(tags);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: '保存标签失败' });
    }
});

// 提供图片文件和缩略图
app.use('/images', express.static(IMAGES_DIR));
app.use('/thumbs', express.static(THUMBS_DIR));

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// 权限检查
app.get('/api/me', (req, res) => {
    res.json({
        isCreator: req.isCreator,
        visitorId: req.visitorId || null
    });
});

// 获取当前访客的「已完成」图片 ID 列表
app.get('/api/me/completed', async (req, res) => {
    try {
        const visitorId = req.visitorId;
        if (!visitorId) return res.json({ completedImageIds: [] });
        const data = await readCompletions();
        const list = data[visitorId] || [];
        res.json({ completedImageIds: list });
    } catch (error) {
        res.status(500).json({ error: '获取完成状态失败' });
    }
});

// 设置完成状态
app.put('/api/images/:id/complete', async (req, res) => {
    try {
        const visitorId = req.visitorId;
        const imageId = req.params.id;
        const { completed } = req.body || {};
        if (!visitorId) return res.status(400).json({ error: '需要访客身份' });
        const data = await readCompletions();
        if (!data[visitorId]) data[visitorId] = [];
        const set = new Set(data[visitorId]);
        if (completed) { set.add(String(imageId)); } else { set.delete(String(imageId)); }
        data[visitorId] = Array.from(set);
        await saveCompletions(data);
        res.json({ completed: !!completed, completedImageIds: data[visitorId] });
    } catch (error) {
        res.status(500).json({ error: '设置完成状态失败' });
    }
});

// ===== 批量生成缩略图（仅创作者可调用，用于给旧图片生成缩略图） =====
app.post('/api/admin/generate-thumbnails', async (req, res) => {
    if (!req.isCreator) {
        return res.status(403).json({ error: '仅创作者可操作' });
    }
    if (!sharp) {
        return res.status(500).json({ error: 'sharp 未安装，无法生成缩略图' });
    }
    
    try {
        const images = await readImages();
        let generated = 0;
        let skipped = 0;
        let failed = 0;
        
        for (const img of images) {
            // 已有缩略图且不是指向原图的，跳过
            if (img.thumbnailUrl && img.thumbnailUrl.startsWith('/thumbs/')) {
                // 检查缩略图文件是否真的存在
                try {
                    await fs.access(path.join(THUMBS_DIR, path.basename(img.thumbnailUrl)));
                    skipped++;
                    continue;
                } catch (e) {
                    // 文件不存在，需要重新生成
                }
            }
            
            const sourceFile = path.join(IMAGES_DIR, img.filename);
            try {
                await fs.access(sourceFile);
            } catch (e) {
                failed++;
                continue;
            }
            
            const thumbFilename = `thumb_${img.filename.replace(/\.\w+$/, '.jpg')}`;
            const thumbUrl = await generateThumbnail(sourceFile, thumbFilename);
            if (thumbUrl) {
                img.thumbnailUrl = thumbUrl;
                generated++;
            } else {
                failed++;
            }
        }
        
        // 同时清理 images.json 中的 dataUrl 字段（减小文件体积）
        const cleanedImages = images.map(img => {
            const { dataUrl, ...rest } = img;
            return rest;
        });
        await saveImages(cleanedImages);
        
        res.json({ success: true, generated, skipped, failed, total: images.length });
    } catch (error) {
        console.error('批量生成缩略图失败:', error);
        res.status(500).json({ error: '批量生成缩略图失败: ' + error.message });
    }
});

// 静态文件目录 - 放在 API 路由之后，确保 API 优先响应
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// 启动服务器
async function startServer() {
    await ensureDirectories();
    console.log('数据目录 DATA_DIR:', DATA_DIR);
    console.log('缩略图目录 THUMBS_DIR:', THUMBS_DIR);
    console.log('sharp 可用:', !!sharp);
    app.listen(PORT, () => {
        console.log(`服务器运行在 http://localhost:${PORT}`);
        console.log(`API文档: http://localhost:${PORT}/api/health`);
    });
}

startServer();
