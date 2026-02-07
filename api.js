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
        
        // 将服务器相对路径转换为完整 URL
        return images.map(img => {
            const fullUrl = img.url && !img.url.startsWith('http') ? `${API_BASE_URL}${img.url}` : img.url;
            const fullThumbUrl = img.thumbnailUrl && !img.thumbnailUrl.startsWith('http') ? `${API_BASE_URL}${img.thumbnailUrl}` : img.thumbnailUrl;
            return {
                ...img,
                dataUrl: img.dataUrl || fullUrl,
                thumbnailUrl: fullThumbUrl || fullUrl || img.dataUrl
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
        const fullUrl = result.url && !result.url.startsWith('http') ? `${API_BASE_URL}${result.url}` : result.url;
        const fullThumbUrl = result.thumbnailUrl && !result.thumbnailUrl.startsWith('http') ? `${API_BASE_URL}${result.thumbnailUrl}` : result.thumbnailUrl;
        return {
            ...result,
            dataUrl: result.dataUrl || fullUrl,
            thumbnailUrl: fullThumbUrl || fullUrl
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

// 获取当前访客的「已完成」图片 ID 列表
async function fetchCompletedIds() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/me/completed`, {
            headers: getAuthHeaders()
        });
        if (!response.ok) return [];
        const data = await response.json();
        return Array.isArray(data.completedImageIds) ? data.completedImageIds : [];
    } catch (e) {
        console.error('获取完成状态失败:', e);
        return [];
    }
}

// 设置某张图片对当前访客的完成状态（打勾/取消）
async function setImageCompleted(imageId, completed) {
    const response = await fetch(`${API_BASE_URL}/api/images/${imageId}/complete`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ completed: !!completed })
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const msg = err.error || err.message || `HTTP ${response.status}`;
        if (response.status === 404) {
            throw new Error('接口未找到(404)，请确认已重启服务器并使用了最新 server.js');
        }
        throw new Error(msg);
    }
    return await response.json();
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
