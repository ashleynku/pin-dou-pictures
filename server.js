// 后端服务器 - 用于存储和共享图片数据（支持创作者/访客权限）
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
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

async function ensureDirectories() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(IMAGES_DIR, { recursive: true });
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

// 读取数据
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

// 读取图片
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

// 保存数据
async function saveImages(images) {
    await fs.writeFile(IMAGES_DB, JSON.stringify(images, null, 2), 'utf8');
}

async function saveTags(tags) {
    await fs.writeFile(TAGS_DB, JSON.stringify(tags, null, 2), 'utf8');
}

// API路由

// 获取所有图片（所有人可浏览，返回每条的上传者信息供前端判断是否可删）
app.get('/api/images', async (req, res) => {
    try {
        const images = await readImages();
        // 兼容旧数据：无 uploadedBy 的视为创作者上传
        const list = images.map(img => ({
            ...img,
            uploadedBy: img.uploadedBy || 'creator',
            visitorId: img.visitorId || null
        }));
        res.json(list);
    } catch (error) {
        res.status(500).json({ error: '获取图片失败' });
    }
});

// 上传图片（从base64）；创作者或访客均可上传，记录上传者
app.post('/api/images', async (req, res) => {
    try {
        const { name, dataUrl, tags, keywords } = req.body;
        
        if (!dataUrl || !dataUrl.startsWith('data:image/')) {
            return res.status(400).json({ error: '无效的图片数据' });
        }
        
        // 访客上传时必须提供 visitorId
        if (!req.isCreator && !req.visitorId) {
            return res.status(400).json({ error: '访客上传请提供 X-Visitor-Id' });
        }
        
        // 将base64转换为文件
        const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        
        // 确定文件扩展名
        const mimeMatch = dataUrl.match(/data:image\/(\w+);base64/);
        const ext = mimeMatch ? mimeMatch[1] : 'png';
        const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`;
        const filepath = path.join(IMAGES_DIR, filename);
        
        // 保存文件
        await fs.writeFile(filepath, buffer);
        
        // 创建图片记录（标记上传者：创作者 / 访客+visitorId）
        const imageData = {
            id: Date.now() + Math.random(),
            name: name || `图片_${Date.now()}`,
            filename: filename,
            url: `/images/${filename}`,
            dataUrl: dataUrl,
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

// 删除图片：仅创作者可删任意图；访客只能删自己上传的
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
        
        try {
            const filepath = path.join(IMAGES_DIR, image.filename);
            await fs.unlink(filepath);
        } catch (error) {
            console.warn('删除文件失败:', error);
        }
        
        const filtered = images.filter(img => img.id != id);
        await saveImages(filtered);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: '删除图片失败' });
    }
});

// 批量删除：仅删除当前用户有权限删除的项
app.post('/api/images/delete-multiple', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids)) {
            return res.status(400).json({ error: '无效的ID列表' });
        }
        
        const images = await readImages();
        const allowedToDelete = images.filter(img => {
            // 统一转为字符串比较，避免类型不一致
            if (!ids.some(id => String(id) === String(img.id))) return false;
            const uploadedBy = img.uploadedBy || 'creator';
            return req.isCreator ||
                (uploadedBy === 'visitor' && img.visitorId && img.visitorId === req.visitorId);
        });
        
        for (const image of allowedToDelete) {
            try {
                const filepath = path.join(IMAGES_DIR, image.filename);
                await fs.unlink(filepath);
            } catch (error) {
                console.warn('删除文件失败:', error);
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

// 保存标签：仅创作者可修改标签
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

// 提供图片文件
app.use('/images', express.static(IMAGES_DIR));

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// 权限检查：返回当前是否为创作者（用于前端展示）
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
        if (!visitorId) {
            return res.json({ completedImageIds: [] });
        }
        const data = await readCompletions();
        const list = data[visitorId] || [];
        res.json({ completedImageIds: list });
    } catch (error) {
        res.status(500).json({ error: '获取完成状态失败' });
    }
});

// 设置某张图片对当前访客的完成状态（打勾/取消）
app.put('/api/images/:id/complete', async (req, res) => {
    try {
        const visitorId = req.visitorId;
        const imageId = req.params.id;
        const { completed } = req.body || {};
        if (!visitorId) {
            return res.status(400).json({ error: '需要访客身份' });
        }
        const data = await readCompletions();
        if (!data[visitorId]) data[visitorId] = [];
        const set = new Set(data[visitorId]);
        if (completed) {
            set.add(String(imageId));
        } else {
            set.delete(String(imageId));
        }
        data[visitorId] = Array.from(set);
        await saveCompletions(data);
        res.json({ completed: !!completed, completedImageIds: data[visitorId] });
    } catch (error) {
        res.status(500).json({ error: '设置完成状态失败' });
    }
});

// 静态文件目录 - 放在 API 路由之后，确保 API 优先响应
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// 启动服务器
async function startServer() {
    await ensureDirectories();
    console.log('数据目录 DATA_DIR:', DATA_DIR);
    app.listen(PORT, () => {
        console.log(`服务器运行在 http://localhost:${PORT}`);
        console.log(`API文档: http://localhost:${PORT}/api/health`);
    });
}

startServer();
