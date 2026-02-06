// IndexedDB 数据库管理
const DB_NAME = 'pinDouPicturesDB';
const DB_VERSION = 1;
const STORE_IMAGES = 'images';
const STORE_TAGS = 'tags';

let db = null;

// 初始化数据库
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => {
            console.error('数据库打开失败:', request.error);
            reject(request.error);
        };
        
        request.onsuccess = () => {
            db = request.result;
            console.log('数据库打开成功');
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
            // 创建图片存储对象
            if (!db.objectStoreNames.contains(STORE_IMAGES)) {
                const imageStore = db.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
                imageStore.createIndex('timestamp', 'timestamp', { unique: false });
                imageStore.createIndex('name', 'name', { unique: false });
            }
            
            // 创建标签存储对象
            if (!db.objectStoreNames.contains(STORE_TAGS)) {
                db.createObjectStore(STORE_TAGS, { keyPath: 'key' });
            }
        };
    });
}

// 压缩图片
function compressImage(dataUrl, maxWidth = 1920, maxHeight = 1920, quality = 0.85) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;
            
            // 计算缩放比例
            if (width > maxWidth || height > maxHeight) {
                const ratio = Math.min(maxWidth / width, maxHeight / height);
                width = width * ratio;
                height = height * ratio;
            }
            
            canvas.width = width;
            canvas.height = height;
            
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            
            // 转换为blob，然后转回dataUrl
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error('图片压缩失败'));
                    return;
                }
                
                const reader = new FileReader();
                reader.onload = () => {
                    resolve(reader.result);
                };
                reader.onerror = () => {
                    reject(new Error('读取压缩图片失败'));
                };
                reader.readAsDataURL(blob);
            }, 'image/jpeg', quality);
        };
        
        img.onerror = () => {
            reject(new Error('图片加载失败'));
        };
        
        img.src = dataUrl;
    });
}

// 保存图片
async function saveImage(imageData) {
    if (!db) {
        await initDB();
    }
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_IMAGES], 'readwrite');
        const store = transaction.objectStore(STORE_IMAGES);
        const request = store.put(imageData);
        
        request.onsuccess = () => {
            resolve(request.result);
        };
        
        request.onerror = () => {
            reject(request.error);
        };
    });
}

// 保存所有图片
async function saveAllImages(images) {
    if (!db) {
        await initDB();
    }
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_IMAGES], 'readwrite');
        const store = transaction.objectStore(STORE_IMAGES);
        
        // 先清空
        store.clear();
        
        // 然后添加所有图片
        let completed = 0;
        let failed = 0;
        
        if (images.length === 0) {
            resolve();
            return;
        }
        
        images.forEach((image, index) => {
            const request = store.put(image);
            
            request.onsuccess = () => {
                completed++;
                if (completed + failed === images.length) {
                    if (failed === 0) {
                        resolve();
                    } else {
                        reject(new Error(`${failed} 张图片保存失败`));
                    }
                }
            };
            
            request.onerror = () => {
                failed++;
                console.error(`保存图片 ${image.id} 失败:`, request.error);
                if (completed + failed === images.length) {
                    reject(new Error(`${failed} 张图片保存失败`));
                }
            };
        });
    });
}

// 获取所有图片
async function getAllImages() {
    if (!db) {
        await initDB();
    }
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_IMAGES], 'readonly');
        const store = transaction.objectStore(STORE_IMAGES);
        const request = store.getAll();
        
        request.onsuccess = () => {
            resolve(request.result || []);
        };
        
        request.onerror = () => {
            reject(request.error);
        };
    });
}

// 删除图片
async function deleteImage(imageId) {
    if (!db) {
        await initDB();
    }
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_IMAGES], 'readwrite');
        const store = transaction.objectStore(STORE_IMAGES);
        const request = store.delete(imageId);
        
        request.onsuccess = () => {
            resolve();
        };
        
        request.onerror = () => {
            reject(request.error);
        };
    });
}

// 删除多个图片
async function deleteImages(imageIds) {
    if (!db) {
        await initDB();
    }
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_IMAGES], 'readwrite');
        const store = transaction.objectStore(STORE_IMAGES);
        
        let completed = 0;
        let failed = 0;
        
        if (imageIds.length === 0) {
            resolve();
            return;
        }
        
        imageIds.forEach((id) => {
            const request = store.delete(id);
            
            request.onsuccess = () => {
                completed++;
                if (completed + failed === imageIds.length) {
                    if (failed === 0) {
                        resolve();
                    } else {
                        reject(new Error(`${failed} 张图片删除失败`));
                    }
                }
            };
            
            request.onerror = () => {
                failed++;
                if (completed + failed === imageIds.length) {
                    reject(new Error(`${failed} 张图片删除失败`));
                }
            };
        });
    });
}

// 保存标签
async function saveTags(tags) {
    if (!db) {
        await initDB();
    }
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_TAGS], 'readwrite');
        const store = transaction.objectStore(STORE_TAGS);
        const request = store.put({ key: 'customTags', value: tags });
        
        request.onsuccess = () => {
            resolve();
        };
        
        request.onerror = () => {
            reject(request.error);
        };
    });
}

// 获取标签
async function getTags() {
    if (!db) {
        await initDB();
    }
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_TAGS], 'readonly');
        const store = transaction.objectStore(STORE_TAGS);
        const request = store.get('customTags');
        
        request.onsuccess = () => {
            resolve(request.result ? request.result.value : []);
        };
        
        request.onerror = () => {
            reject(request.error);
        };
    });
}

// 获取本地「已完成」图片 ID 列表
async function getCompletedIds() {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_TAGS], 'readonly');
        const store = transaction.objectStore(STORE_TAGS);
        const request = store.get('completedImageIds');
        request.onsuccess = () => {
            const val = request.result ? request.result.value : [];
            resolve(Array.isArray(val) ? val : []);
        };
        request.onerror = () => reject(request.error);
    });
}

// 保存本地「已完成」图片 ID 列表
async function saveCompletedIds(ids) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_TAGS], 'readwrite');
        const store = transaction.objectStore(STORE_TAGS);
        const request = store.put({ key: 'completedImageIds', value: ids });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// 迁移localStorage数据到IndexedDB
async function migrateFromLocalStorage() {
    try {
        const savedImages = localStorage.getItem('pinDouImages');
        const savedCustomTags = localStorage.getItem('pinDouCustomTags');
        
        if (savedImages) {
            const images = JSON.parse(savedImages);
            if (images.length > 0) {
                await saveAllImages(images);
                console.log(`已迁移 ${images.length} 张图片到IndexedDB`);
                // 迁移后删除localStorage数据
                localStorage.removeItem('pinDouImages');
            }
        }
        
        if (savedCustomTags) {
            const tags = JSON.parse(savedCustomTags);
            if (tags.length > 0) {
                await saveTags(tags);
                console.log(`已迁移 ${tags.length} 个自定义标签到IndexedDB`);
                // 迁移后删除localStorage数据
                localStorage.removeItem('pinDouCustomTags');
            }
        }
    } catch (error) {
        console.error('数据迁移失败:', error);
    }
}
