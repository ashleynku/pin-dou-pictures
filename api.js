// API客户端 - 用于与服务器通信（支持创作者/访客权限）
const API_BASE_URL = window.location.origin;

const STORAGE_CREATOR_TOKEN = 'pinDou_creatorToken';
const STORAGE_VISITOR_ID = 'pinDou_visitorId';

// 创作者密钥（仅存储在本地，请求时带在 header）
function getCreatorToken() {
    try {
        return localStorage.getItem(STORAGE_CREATOR_TOKEN) || '';
    } catch (e) {
        return '';
    }
}

function setCreatorToken(token) {
    try {
        if (token) {
            localStorage.setItem(STORAGE_CREATOR_TOKEN, token);
        } else {
            localStorage.removeItem(STORAGE_CREATOR_TOKEN);
        }
    } catch (e) {}
}

// 访客唯一 ID（用于标识本人上传，以便仅本人可删）
function getVisitorId() {
    try {
        let id = localStorage.getItem(STORAGE_VISITOR_ID);
        if (!id) {
            id = 'v_' + Date.now() + '_' + Math.random().toString(36).substring(2, 12);
            localStorage.setItem(STORAGE_VISITOR_ID, id);
        }
        return id;
    } catch (e) {
        return 'v_' + Date.now();
    }
}

// 请求头：携带创作者令牌和访客 ID
function getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const token = getCreatorToken();
    const visitorId = getVisitorId();
    if (token) headers['X-Creator-Token'] = token;
    headers['X-Visitor-Id'] = visitorId;
    return headers;
}

// 检查服务器连接（必须返回 JSON 且 status 为 ok，避免静态托管如 GitHub Pages 对 /api/* 返回 index.html 导致误判）
async function checkServerConnection() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${API_BASE_URL}/api/health`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) return false;
        const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
        if (!contentType.includes('application/json')) return false;
        const data = await response.json();
        return !!(data && data.status === 'ok');
    } catch (error) {
        return false;
    }
}

// 获取当前用户身份（是否创作者）
async function fetchMe() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/me`, {
            headers: {
                'X-Creator-Token': getCreatorToken() || '',
                'X-Visitor-Id': getVisitorId()
            }
        });
        if (!response.ok) return { isCreator: false, visitorId: getVisitorId() };
        const data = await response.json();
        return {
            isCreator: !!data.isCreator,
            visitorId: data.visitorId || getVisitorId()
        };
    } catch (e) {
        return { isCreator: false, visitorId: getVisitorId() };
    }
}

// 获取所有图片
async function fetchAllImages() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/images`);
        if (!response.ok) throw new Error('获取图片失败');
        const images = await response.json();
        
        // 将服务器URL转换为完整的dataUrl（用于兼容）
        return images.map(img => {
            // 如果已有dataUrl，直接使用；否则从URL加载
            if (img.dataUrl) {
                return img;
            }
            return {
                ...img,
                dataUrl: img.url.startsWith('http') ? img.url : `${API_BASE_URL}${img.url}`
            };
        });
    } catch (error) {
        console.error('获取图片失败:', error);
        throw error;
    }
}

// 上传图片（自动带创作者/访客身份）
async function uploadImage(imageData) {
    try {
        const body = {
            name: imageData.name,
            dataUrl: imageData.dataUrl,
            tags: imageData.tags || [],
            keywords: imageData.keywords || []
        };
        const response = await fetch(`${API_BASE_URL}/api/images`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(body)
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '上传失败');
        }
        
        const result = await response.json();
        return {
            ...result,
            dataUrl: result.url.startsWith('http') ? result.url : `${API_BASE_URL}${result.url}`
        };
    } catch (error) {
        console.error('上传图片失败:', error);
        throw error;
    }
}

// 删除图片（服务端按创作者/访客权限校验）
async function deleteImage(imageId) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/images/${imageId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || '删除失败');
        }
        return await response.json();
    } catch (error) {
        console.error('删除图片失败:', error);
        throw error;
    }
}

// 批量删除图片（服务端只删除有权限的项）
async function deleteImages(imageIds) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/images/delete-multiple`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ ids: imageIds })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || '批量删除失败');
        }
        return await response.json();
    } catch (error) {
        console.error('批量删除失败:', error);
        throw error;
    }
}

// 获取标签
async function fetchTags() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/tags`);
        if (!response.ok) throw new Error('获取标签失败');
        return await response.json();
    } catch (error) {
        console.error('获取标签失败:', error);
        return [];
    }
}

// 保存标签（仅创作者可成功）
async function saveTags(tags) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/tags`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(tags)
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || '保存标签失败');
        }
        return await response.json();
    } catch (error) {
        console.error('保存标签失败:', error);
        throw error;
    }
}
