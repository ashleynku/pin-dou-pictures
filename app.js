// 应用状态
const appState = {
    images: [],
    selectedTags: new Set(),
    selectMode: false,
    selectedImages: new Set(),
    previewFiles: [],
    currentImageForConvert: null,
    convertFile: null,
    convertConfirmed: false,
    customTags: [],
    imageViewerZoom: 100,
    detailImageZoom: 100,
    detailImagePan: { x: 0, y: 0 },
    detailImageDragging: false,
    detailImageDragStart: { x: 0, y: 0 },
    scrollPosition: 0,
    useServer: false,
    isCreator: false,   // 当前是否为创作者（仅服务器模式有效）
    visitorId: null,    // 当前访客 ID（仅服务器模式有效）
    completedImageIds: new Set(),   // 当前访客/本地已标记「已完成」的图片 ID
    completionFilter: 'all'        // 图库筛选：'all' | 'completed' | 'uncompleted'
};

// 初始标签池
const initialTags = ['小图', '可爱', '食物', '动物', '植物', '节日'];

// 随机渐变配色生成器
const gradientColors = [
    ['#667eea', '#764ba2'],
    ['#f093fb', '#4facfe'],
    ['#4facfe', '#00f2fe'],
    ['#43e97b', '#38f9d7'],
    ['#fa709a', '#fee140'],
    ['#30cfd0', '#330867'],
    ['#a8edea', '#fed6e3'],
    ['#ff9a9e', '#fecfef'],
    ['#ffecd2', '#fcb69f'],
    ['#ff8a80', '#ea4c89']
];

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    // 显示加载提示
    showLoadingState();
    // 非本地访问时直接从 DOM 移除「迁移到服务器」，避免任何代码路径再显示
    const migrateLinkEl = document.getElementById('migrateLink');
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:';
    if (migrateLinkEl && !isLocal) {
        migrateLinkEl.remove();
    }
    // 检查服务器连接
    const serverAvailable = await checkServerConnection();
    appState.useServer = serverAvailable;
    
    if (serverAvailable) {
        console.log('✅ 检测到服务器，使用共享模式');
        initEventListeners();
        initRouter();
        document.getElementById('convertSection').style.display = 'block';
        const [me, _] = await Promise.all([fetchMe(), loadDataAndRender()]);
        appState.isCreator = me.isCreator;
        appState.visitorId = me.visitorId;
        updateCreatorUI();
    } else {
        console.log('ℹ️ 未检测到服务器，使用本地模式');
        // 本地模式：使用IndexedDB
        initDB().then(async () => {
            await migrateFromLocalStorage();
            initEventListeners();
            initRouter();
            document.getElementById('convertSection').style.display = 'block';
            await loadDataAndRender();
            // 仅在本机 localhost 时显示「迁移到服务器」（非 localhost 时该元素已被 remove）
            const migrateLink = document.getElementById('migrateLink');
            if (migrateLink && isLocal) migrateLink.style.display = 'inline-block';
        }).catch(error => {
            console.error('数据库初始化失败:', error);
            hideLoadingState();
            alert('数据库初始化失败，请刷新页面重试');
        });
    }
});

// 加载数据并渲染（优化版本：标签与图库并行请求，首屏尽快出图）
async function loadDataAndRender() {
    try {
        if (appState.useServer) {
            const [tags, images, completedIds] = await Promise.all([
                fetchTags(),
                fetchAllImages(),
                fetchCompletedIds()
            ]);
            appState.customTags = tags;
            appState.images = images;
            appState.completedImageIds = new Set(completedIds.map(String));
            renderTags();
            hideLoadingState();
            renderGallery();
        } else {
            appState.customTags = await getTags();
            const completedIds = await getCompletedIds();
            appState.completedImageIds = new Set(completedIds.map(String));
            renderTags();
            await loadImagesInBatches();
            hideLoadingState();
            renderGallery();
        }
    } catch (error) {
        console.error('加载数据失败:', error);
        hideLoadingState();
        appState.images = [];
        appState.customTags = [];
        renderTags();
        renderGallery();
    }
}

// 首批出图数量：达到后立即渲染并隐藏加载态，缩短“图片出现”时间
const INITIAL_BATCH_SIZE = 48;

// 分批加载图片（首批到达即出图，其余后台追加）
async function loadImagesInBatches() {
    if (!db) {
        await initDB();
    }
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_IMAGES], 'readonly');
        const store = transaction.objectStore(STORE_IMAGES);
        const request = store.openCursor();
        
        appState.images = [];
        let batch = [];
        let firstPaintDone = false;
        
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            
            if (cursor) {
                batch.push(cursor.value);
                
                // 首屏：达到 INITIAL_BATCH_SIZE 立即渲染并隐藏加载态
                if (!firstPaintDone && batch.length >= INITIAL_BATCH_SIZE) {
                    appState.images.push(...batch);
                    firstPaintDone = true;
                    hideLoadingState();
                    renderGallery();
                    batch = [];
                } else if (firstPaintDone && batch.length >= 50) {
                    appState.images.push(...batch);
                    renderGallery();
                    batch = [];
                }
                
                cursor.continue();
            } else {
                if (batch.length > 0) {
                    appState.images.push(...batch);
                }
                if (!firstPaintDone) {
                    firstPaintDone = true;
                    hideLoadingState();
                }
                renderGallery();
                resolve();
            }
        };
        
        request.onerror = () => {
            reject(request.error);
        };
    });
}

// 显示加载状态
function showLoadingState() {
    const galleryGrid = document.getElementById('galleryGrid');
    if (galleryGrid) {
        galleryGrid.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>加载中...</p></div>';
    }
}

// 隐藏加载状态
function hideLoadingState() {
    // 加载状态会在renderGallery中被替换，这里不需要额外操作
}

// 加载本地存储数据（已废弃，改用loadImagesInBatches）
async function loadData() {
    try {
        appState.images = await getAllImages();
        appState.customTags = await getTags();
        console.log(`已加载 ${appState.images.length} 张图片`);
    } catch (error) {
        console.error('加载数据失败:', error);
        appState.images = [];
        appState.customTags = [];
    }
}


// 保存数据（支持服务器和本地两种模式）
async function saveData() {
    try {
        if (appState.useServer) {
            // 服务器模式：只保存标签（图片已通过API上传）
            await saveTags(appState.customTags);
        } else {
            // 本地模式：保存图片和标签
            await saveAllImages(appState.images);
            await saveTags(appState.customTags);
        }
        console.log('数据保存成功');
    } catch (error) {
        console.error('保存数据失败:', error);
        alert('保存失败：' + error.message + '\n\n请重试或刷新页面。');
        throw error;
    }
}


// 初始化事件监听器
function initEventListeners() {
    // 文件输入（上传区）
    const fileInput = document.getElementById('fileInput');
    const uploadArea = document.getElementById('uploadArea');
    
    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('dragover', handleDragOver);
    uploadArea.addEventListener('drop', handleDrop);
    fileInput.addEventListener('change', handleFileSelect);
    
    // 上传表单
    document.getElementById('submitBtn').addEventListener('click', handleSubmit);
    
    // 转换区文件输入
    const convertFileInput = document.getElementById('convertFileInput');
    const convertUploadArea = document.getElementById('convertUploadArea');
    
    convertUploadArea.addEventListener('click', () => convertFileInput.click());
    convertUploadArea.addEventListener('dragover', handleConvertDragOver);
    convertUploadArea.addEventListener('drop', handleConvertDrop);
    convertFileInput.addEventListener('change', handleConvertFileSelect);
    
    // 搜索
    document.getElementById('searchInput').addEventListener('input', handleSearch);
    
    // 标签相关
    document.getElementById('addTagBtn').addEventListener('click', showAddTagModal);
    document.getElementById('confirmTagBtn').addEventListener('click', confirmAddTag);
    document.getElementById('cancelTagBtn').addEventListener('click', hideAddTagModal);
    
    // 转换功能
    document.getElementById('convertBtn').addEventListener('click', convertToPixel);
    document.getElementById('confirmConvertBtn').addEventListener('click', confirmConvert);
    document.getElementById('savePixelBtn').addEventListener('click', savePixelImage);
    document.getElementById('uploadToGalleryBtn').addEventListener('click', uploadToGallery);
    document.getElementById('convertChangeBtn').addEventListener('click', handleConvertChange);
    
    // 右键保存像素图
    const pixelCanvas = document.getElementById('pixelCanvas');
    pixelCanvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (pixelCanvas.width && pixelCanvas.height && appState.convertConfirmed) {
            savePixelImage();
        }
    });
    
    // 图库管理
    document.getElementById('selectModeBtn').addEventListener('click', toggleSelectMode);
    document.getElementById('deleteSelectedBtn').addEventListener('click', deleteSelected);
    document.getElementById('downloadSelectedBtn').addEventListener('click', downloadSelected);
    document.getElementById('cancelSelectBtn').addEventListener('click', cancelSelectMode);
    
    // 完成状态筛选（全部 / 未完成 / 已完成）
    const completionFilterEl = document.getElementById('completionFilter');
    if (completionFilterEl) {
        completionFilterEl.addEventListener('click', (e) => {
            const btn = e.target.closest('.completion-filter-btn');
            if (!btn || !btn.dataset.filter) return;
            appState.completionFilter = btn.dataset.filter;
            completionFilterEl.querySelectorAll('.completion-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderGallery();
        });
    }
    
    // 详情页
    document.getElementById('backBtn').addEventListener('click', goBackToGallery);
    
    // 浏览器后退按钮支持
    window.addEventListener('popstate', handleRouteChange);
    
    // 创作者设置（仅服务器模式）
    const creatorSettingsBtn = document.getElementById('creatorSettingsBtn');
    const creatorConfirmBtn = document.getElementById('creatorConfirmBtn');
    const creatorCancelBtn = document.getElementById('creatorCancelBtn');
    const creatorLogoutBtn = document.getElementById('creatorLogoutBtn');
    if (creatorSettingsBtn) creatorSettingsBtn.addEventListener('click', showCreatorModal);
    if (creatorConfirmBtn) creatorConfirmBtn.addEventListener('click', confirmCreatorToken);
    if (creatorCancelBtn) creatorCancelBtn.addEventListener('click', hideCreatorModal);
    if (creatorLogoutBtn) creatorLogoutBtn.addEventListener('click', logoutCreator);
    const creatorLogoutLink = document.getElementById('creatorLogoutLink');
    if (creatorLogoutLink) creatorLogoutLink.addEventListener('click', logoutCreator);
}

// 拖拽处理
function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.style.borderColor = '#764ba2';
}

function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.style.borderColor = '#667eea';
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
        handleFiles(files);
    } else {
        alert('请拖拽有效的图片文件');
    }
}

function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
        handleFiles(files);
    }
    // 重置input，允许重复选择同一文件
    e.target.value = '';
}

// 处理文件
function handleFiles(files) {
    // 过滤有效图片文件
    const validFiles = Array.from(files).filter(file => {
        // 检查文件类型
        if (!file.type || !file.type.startsWith('image/')) {
            // 如果MIME类型不可用，检查文件扩展名
            const validExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
            const fileName = file.name.toLowerCase();
            const hasValidExtension = validExtensions.some(ext => fileName.endsWith(ext));
            if (!hasValidExtension) {
                console.warn(`文件 ${file.name} 不是有效的图片格式`);
                return false;
            }
        }
        
        // 检查文件大小（限制为10MB）
        const maxSize = 10 * 1024 * 1024; // 10MB
        if (file.size > maxSize) {
            alert(`文件 ${file.name} 太大（${(file.size / 1024 / 1024).toFixed(2)}MB），最大支持10MB`);
            return false;
        }
        
        return true;
    });
    
    if (validFiles.length === 0) {
        alert('没有有效的图片文件');
        return;
    }
    
    if (validFiles.length < files.length) {
        alert(`已过滤 ${files.length - validFiles.length} 个无效文件`);
    }
    
    appState.previewFiles = [];
    let loadedCount = 0;
    const totalFiles = validFiles.length;
    
    validFiles.forEach((file, index) => {
        const reader = new FileReader();
        
        reader.onload = async (e) => {
            try {
                let dataUrl = e.target.result;
                
                // 压缩图片（如果图片较大）
                const img = new Image();
                img.src = dataUrl;
                await new Promise((resolve) => {
                    img.onload = resolve;
                });
                
                // 如果图片宽度或高度超过1920px，进行压缩
                if (img.width > 1920 || img.height > 1920) {
                    try {
                        dataUrl = await compressImage(dataUrl, 1920, 1920, 0.85);
                        console.log(`图片 ${file.name} 已压缩`);
                    } catch (compressError) {
                        console.warn(`压缩图片 ${file.name} 失败，使用原图:`, compressError);
                    }
                }
                
                appState.previewFiles.push({
                    file: file,
                    dataUrl: dataUrl,
                    name: file.name
                });
                
                loadedCount++;
                
                // 所有文件加载完成后显示预览
                if (loadedCount === totalFiles) {
                    renderPreview();
                    document.getElementById('uploadForm').style.display = 'block';
                }
            } catch (error) {
                console.error(`处理文件 ${file.name} 时出错:`, error);
                alert(`处理文件 ${file.name} 时出错`);
                loadedCount++;
            }
        };
        
        reader.onerror = (error) => {
            console.error(`读取文件 ${file.name} 失败:`, error);
            alert(`读取文件 ${file.name} 失败，请重试`);
            loadedCount++;
            if (loadedCount === totalFiles && appState.previewFiles.length === 0) {
                document.getElementById('uploadForm').style.display = 'none';
            }
        };
        
        reader.onabort = () => {
            console.warn(`读取文件 ${file.name} 被中断`);
            loadedCount++;
        };
        
        try {
            reader.readAsDataURL(file);
        } catch (error) {
            console.error(`无法读取文件 ${file.name}:`, error);
            alert(`无法读取文件 ${file.name}`);
            loadedCount++;
        }
    });
}

// 渲染预览
function renderPreview() {
    const preview = document.getElementById('uploadPreview');
    preview.innerHTML = '';
    
    appState.previewFiles.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'preview-item';
        div.innerHTML = `
            <img src="${item.dataUrl}" alt="${item.name}">
            <button class="remove-preview" data-index="${index}">×</button>
        `;
        preview.appendChild(div);
    });
    
    // 移除预览按钮
    preview.querySelectorAll('.remove-preview').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(e.target.dataset.index);
            appState.previewFiles.splice(index, 1);
            renderPreview();
            if (appState.previewFiles.length === 0) {
                document.getElementById('uploadForm').style.display = 'none';
            }
        });
    });
}

// 提交上传
async function handleSubmit() {
    // 检查是否有待上传的文件
    if (!appState.previewFiles || appState.previewFiles.length === 0) {
        alert('请先选择要上传的图片');
        return;
    }
    
    const tagsInput = document.getElementById('tagsInput').value.trim();
    const keywordsInput = document.getElementById('keywordsInput').value.trim();
    
    const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(t => t) : [];
    const keywords = keywordsInput ? keywordsInput.split(',').map(k => k.trim()).filter(k => k) : [];
    
    // 禁用提交按钮，防止重复提交
    const submitBtn = document.getElementById('submitBtn');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = '上传中...';
    
    try {
        let successCount = 0;
        let failCount = 0;
        
        appState.previewFiles.forEach((item, index) => {
            try {
                // 检查dataUrl是否有效
                if (!item.dataUrl || !item.dataUrl.startsWith('data:image/')) {
                    console.error(`文件 ${item.name} 的数据无效`);
                    failCount++;
                    return;
                }
                
                const imageData = {
                    id: Date.now() + Math.random() + index,
                    name: item.name || `图片_${Date.now()}_${index}`,
                    dataUrl: item.dataUrl,
                    tags: tags,
                    keywords: keywords,
                    timestamp: Date.now()
                };
                // 仅本地模式在此处加入图库，服务器模式等上传成功后再 push，避免重复
                if (!appState.useServer) {
                    appState.images.push(imageData);
                }
                successCount++;
            } catch (error) {
                console.error(`处理文件 ${item.name} 时出错:`, error);
                failCount++;
            }
        });
        
        if (successCount === 0) {
            alert('没有成功上传任何图片，请重试');
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
            return;
        }
        
        // 保存数据
        try {
            if (appState.useServer) {
                // 服务器模式：逐个上传到服务器
                let uploadedCount = 0;
                for (const item of appState.previewFiles) {
                    if (!item.dataUrl || !item.dataUrl.startsWith('data:image/')) {
                        continue;
                    }
                    
                    try {
                        const uploadedImage = await uploadImage({
                            name: item.name,
                            dataUrl: item.dataUrl,
                            tags: tags,
                            keywords: keywords
                        });
                        appState.images.push(uploadedImage);
                        uploadedCount++;
                    } catch (uploadError) {
                        console.error(`上传 ${item.name} 失败:`, uploadError);
                        failCount++;
                    }
                }
                
                if (uploadedCount > 0) {
                    await saveData(); // 保存标签
                }
                
                if (failCount > 0) {
                    alert(`成功上传 ${uploadedCount} 张图片，${failCount} 张失败`);
                } else {
                    console.log(`成功上传 ${uploadedCount} 张图片`);
                }
            } else {
                // 本地模式：原有逻辑
                await saveData();
                
                if (failCount > 0) {
                    alert(`成功上传 ${successCount} 张图片，${failCount} 张失败`);
                } else {
                    console.log(`成功上传 ${successCount} 张图片`);
                }
            }
            
            renderGallery();
            
            // 重置表单，显示上传区域以便继续上传
            appState.previewFiles = [];
            document.getElementById('uploadPreview').innerHTML = '';
            document.getElementById('uploadForm').style.display = 'none';
            document.getElementById('tagsInput').value = '';
            document.getElementById('keywordsInput').value = '';
            document.getElementById('fileInput').value = '';
            // 上传区保持可见，方便用户继续上传下一批
        } catch (saveError) {
            // 保存失败，回滚已添加的图片
            if (!appState.useServer) {
                appState.images.splice(-successCount);
            }
            alert('保存失败：' + saveError.message);
        }
    } catch (error) {
        console.error('上传过程中出错:', error);
        alert('上传失败：' + error.message);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    }
}

// 渲染标签
function renderTags() {
    const tagsList = document.getElementById('tagsList');
    tagsList.innerHTML = '';
    
    // 初始标签
    initialTags.forEach(tag => {
        const btn = createTagButton(tag, false);
        tagsList.appendChild(btn);
    });
    
    // 自定义标签
    appState.customTags.forEach(tagData => {
        const btn = createTagButton(tagData.name, true, tagData.colors);
        tagsList.appendChild(btn);
    });
}

// 创建标签按钮
function createTagButton(tagName, isCustom = false, colors = null) {
    const btn = document.createElement('button');
    btn.className = 'tag-btn' + (isCustom ? ' custom-tag' : '');
    btn.textContent = tagName;
    btn.setAttribute('data-tag', tagName);
    
    if (isCustom && colors) {
        btn.style.background = `linear-gradient(135deg, ${colors[0]} 0%, ${colors[1]} 100%)`;
    }
    
    if (isCustom) {
        const deleteIcon = document.createElement('span');
        deleteIcon.className = 'delete-tag-icon';
        deleteIcon.textContent = '×';
        deleteIcon.style.cssText = 'position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 16px; cursor: pointer;';
        deleteIcon.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteCustomTag(tagName);
        });
        btn.appendChild(deleteIcon);
    }
    
    btn.addEventListener('click', () => toggleTag(tagName, btn));
    
    if (appState.selectedTags.has(tagName)) {
        btn.classList.add('active');
    }
    
    return btn;
}

// 切换标签选择
function toggleTag(tagName, btn) {
    if (appState.selectedTags.has(tagName)) {
        appState.selectedTags.delete(tagName);
        btn.classList.remove('active');
    } else {
        appState.selectedTags.add(tagName);
        btn.classList.add('active');
    }
    
    renderGallery();
}

// 显示添加标签模态框
function showAddTagModal() {
    if (appState.useServer && !appState.isCreator) {
        alert('仅创作者可新建标签，访客只能使用现有标签。');
        return;
    }
    document.getElementById('tagModal').style.display = 'flex';
    document.getElementById('newTagInput').value = '';
    document.getElementById('newTagInput').focus();
}

// 隐藏添加标签模态框
function hideAddTagModal() {
    document.getElementById('tagModal').style.display = 'none';
}

// 创作者设置：登录后持久有效，不显示「访客/创作者」身份；仅访客可见「创作者登录」，创作者可见「退出创作者」
function updateCreatorUI() {
    if (!appState.useServer) return;
    const settingsBtn = document.getElementById('creatorSettingsBtn');
    const logoutLink = document.getElementById('creatorLogoutLink');
    const logoutBtn = document.getElementById('creatorLogoutBtn');
    const tokenInput = document.getElementById('creatorTokenInput');
    if (settingsBtn) {
        settingsBtn.style.display = appState.isCreator ? 'none' : 'inline-block';
    }
    if (logoutLink) {
        logoutLink.style.display = appState.isCreator ? 'inline-block' : 'none';
    }
    if (logoutBtn) {
        logoutBtn.style.display = appState.isCreator ? 'inline-block' : 'none';
    }
    if (tokenInput) tokenInput.value = '';
}

function showCreatorModal() {
    document.getElementById('creatorModal').style.display = 'flex';
    document.getElementById('creatorTokenInput').value = '';
    document.getElementById('creatorTokenInput').focus();
}

function hideCreatorModal() {
    document.getElementById('creatorModal').style.display = 'none';
}

async function confirmCreatorToken() {
    const token = document.getElementById('creatorTokenInput').value.trim();
    if (!token) {
        alert('请输入创作者密钥');
        return;
    }
    setCreatorToken(token);
    const me = await fetchMe();
    appState.isCreator = me.isCreator;
    appState.visitorId = me.visitorId;
    if (appState.isCreator) {
        // 登录成功，密钥已持久保存，刷新后无需再次登录
    } else {
        alert('密钥无效，当前为访客身份。请确认部署时设置的 CREATOR_SECRET。');
        setCreatorToken('');
    }
    hideCreatorModal();
    updateCreatorUI();
    renderGallery();
}

function logoutCreator() {
    setCreatorToken('');
    appState.isCreator = false;
    appState.visitorId = getVisitorId();
    hideCreatorModal();
    updateCreatorUI();
    renderGallery();
}

// 确认添加标签
async function confirmAddTag() {
    const tagName = document.getElementById('newTagInput').value.trim();
    
    if (!tagName) {
        alert('请输入标签名称');
        return;
    }
    
    if (initialTags.includes(tagName) || appState.customTags.some(t => t.name === tagName)) {
        alert('标签已存在');
        return;
    }
    
    const colors = gradientColors[appState.customTags.length % gradientColors.length];
    appState.customTags.push({ name: tagName, colors: colors });
    
    if (appState.useServer) {
        await saveTags(appState.customTags);
    } else {
        await saveData();
    }
    
    renderTags();
    hideAddTagModal();
}

// 删除自定义标签
async function deleteCustomTag(tagName) {
    if (confirm(`确定要删除标签"${tagName}"吗？`)) {
        appState.customTags = appState.customTags.filter(t => t.name !== tagName);
        appState.selectedTags.delete(tagName);
        
        if (appState.useServer) {
            await saveTags(appState.customTags);
        } else {
            await saveData();
        }
        
        renderTags();
        renderGallery();
    }
}

// 搜索处理
function handleSearch() {
    renderGallery();
}

// 首屏先渲染的图片数量，其余分块渲染以缩短“出现时间”
const RENDER_INITIAL_CHUNK = 48;
const RENDER_CHUNK_SIZE = 60;

// 渲染图库（首屏先出图，其余分块渲染）
function renderGallery() {
    const galleryGrid = document.getElementById('galleryGrid');
    if (!galleryGrid) return;
    
    const searchTerm = document.getElementById('searchInput')?.value.toLowerCase().trim() || '';
    const selectedTagsArray = Array.from(appState.selectedTags);
    
    let filteredImages = appState.images.filter(img => {
        if (searchTerm) {
            const matchName = img.name.toLowerCase().includes(searchTerm);
            const matchKeywords = img.keywords?.some(k => k.toLowerCase().includes(searchTerm)) || false;
            if (!matchName && !matchKeywords) return false;
        }
        if (selectedTagsArray.length > 0) {
            const imgTags = [...(img.tags || [])];
            const hasAllTags = selectedTagsArray.every(tag => imgTags.includes(tag));
            if (!hasAllTags) return false;
        }
        const idStr = String(img.id);
        const isCompleted = appState.completedImageIds.has(idStr);
        if (appState.completionFilter === 'completed' && !isCompleted) return false;
        if (appState.completionFilter === 'uncompleted' && isCompleted) return false;
        return true;
    });
    
    galleryGrid.innerHTML = '';
    
    if (filteredImages.length === 0) {
        const emptyMsg = document.createElement('p');
        emptyMsg.style.cssText = 'grid-column: 1/-1; text-align: center; color: #999; padding: 40px;';
        emptyMsg.textContent = '暂无图片';
        galleryGrid.appendChild(emptyMsg);
    } else if (filteredImages.length <= RENDER_INITIAL_CHUNK) {
        const fragment = document.createDocumentFragment();
        filteredImages.forEach(img => fragment.appendChild(createGalleryItem(img)));
        galleryGrid.appendChild(fragment);
        updateGalleryCount();
    } else {
        // 先渲染首屏，再分块渲染其余，缩短“图片出现”的等待时间
        const firstChunk = document.createDocumentFragment();
        for (let i = 0; i < RENDER_INITIAL_CHUNK; i++) {
            firstChunk.appendChild(createGalleryItem(filteredImages[i]));
        }
        galleryGrid.appendChild(firstChunk);
        updateGalleryCount();
        let index = RENDER_INITIAL_CHUNK;
        function addNextChunk() {
            if (index >= filteredImages.length) {
                updateGalleryCount();
                return;
            }
            const fragment = document.createDocumentFragment();
            const end = Math.min(index + RENDER_CHUNK_SIZE, filteredImages.length);
            for (let i = index; i < end; i++) {
                fragment.appendChild(createGalleryItem(filteredImages[i]));
            }
            galleryGrid.appendChild(fragment);
            index = end;
            if (index < filteredImages.length) {
                requestAnimationFrame(addNextChunk);
            } else {
                updateGalleryCount();
            }
        }
        requestAnimationFrame(addNextChunk);
    }
}

// 当前用户是否可删除该图片（仅服务器模式有效）
function canDeleteImage(img) {
    if (!appState.useServer) return true;
    if (appState.isCreator) return true;
    const uploadedBy = img.uploadedBy || 'creator';
    return uploadedBy === 'visitor' && img.visitorId && img.visitorId === appState.visitorId;
}

// 创建单个图库项（优化版本）
function createGalleryItem(img) {
    const item = document.createElement('div');
    item.className = 'gallery-item' + (appState.selectMode ? ' select-mode' : '');
    item.dataset.id = img.id;
    
    const idStr = String(img.id);
    const isSelected = appState.selectedImages.has(idStr);
    // 选择模式下显示所有图片的选择框（用于下载/删除）
    const showCheckbox = appState.selectMode;
    const isCompleted = appState.completedImageIds.has(idStr);
    
    item.innerHTML = `
        ${showCheckbox ? `<input type="checkbox" class="gallery-item-checkbox" ${isSelected ? 'checked' : ''} data-id="${idStr}">` : ''}
        ${isCompleted ? '<span class="gallery-item-badge-completed">已完成</span>' : ''}
        <img src="${img.thumbnailUrl || img.dataUrl}" alt="${img.name}" loading="lazy" decoding="async">
        <div class="gallery-item-info">
            <div class="gallery-item-title" title="${img.name}">${img.name}</div>
            ${img.tags && img.tags.length > 0 ? `
                <div class="gallery-item-tags">
                    ${img.tags.map(tag => `<span class="gallery-item-tag">${tag}</span>`).join('')}
                </div>
            ` : ''}
        </div>
    `;
    
    if (!appState.selectMode) {
        const imgElement = item.querySelector('img');
        imgElement.addEventListener('click', (e) => {
            e.stopPropagation();
            appState.scrollPosition = window.scrollY;
            navigateToDetail(img.id);
        });
    }
    
    const checkbox = item.querySelector('.gallery-item-checkbox');
    if (checkbox) {
        checkbox.addEventListener('change', (e) => {
            const imgIdStr = String(img.id);
            if (e.target.checked) {
                appState.selectedImages.add(imgIdStr);
            } else {
                appState.selectedImages.delete(imgIdStr);
            }
            updateSelectionBar();
        });
    }
    
    return item;
}

// 更新图库总数显示
function updateGalleryCount() {
    const el = document.getElementById('galleryCount');
    if (!el) return;
    el.textContent = `共 ${appState.images.length} 张`;
}

// 转换区拖拽处理
function handleConvertDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.style.borderColor = '#764ba2';
}

function handleConvertDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.style.borderColor = '#667eea';
    
    const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/'));
    if (files.length > 0) {
        handleConvertFile(files[0]);
    }
}

function handleConvertFileSelect(e) {
    const files = Array.from(e.target.files).filter(file => file.type.startsWith('image/'));
    if (files.length > 0) {
        handleConvertFile(files[0]);
    }
}

// 处理转换文件
function handleConvertFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        appState.convertFile = {
            file: file,
            dataUrl: e.target.result,
            name: file.name
        };
        
        // 显示原图
        const originalCanvas = document.getElementById('originalCanvas');
        const img = new Image();
        img.onload = () => {
            originalCanvas.width = img.width;
            originalCanvas.height = img.height;
            const ctx = originalCanvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            
            // 显示设置面板和预览区域，隐藏上传区域
            document.getElementById('convertSettings').style.display = 'block';
            document.getElementById('convertPreview').style.display = 'grid';
            document.getElementById('convertUploadArea').style.display = 'none';
            
            // 重置像素图画布和确认状态
            const pixelCanvas = document.getElementById('pixelCanvas');
            const pixCtx = pixelCanvas.getContext('2d');
            pixCtx.clearRect(0, 0, pixelCanvas.width, pixelCanvas.height);
            pixelCanvas.width = 0;
            pixelCanvas.height = 0;
            appState.convertConfirmed = false;
            document.getElementById('convertActions').style.display = 'none';
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

// 换图按钮：触发文件选择
function handleConvertChange() {
    document.getElementById('convertFileInput').click();
}

// ===== 中位切分颜色量化算法（Median Cut） =====
function medianCutQuantize(pixels, colorCount) {
    if (colorCount <= 0) return null; // 不限制

    // 收集所有不透明像素的颜色
    const colors = [];
    for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] > 128) {
            colors.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
        }
    }
    if (colors.length === 0) return null;

    // 递归切分颜色空间
    function splitBucket(bucket, depth) {
        if (depth === 0 || bucket.length === 0) return [bucket];

        // 找出 R/G/B 范围最大的通道
        let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
        for (const c of bucket) {
            if (c[0] < minR) minR = c[0]; if (c[0] > maxR) maxR = c[0];
            if (c[1] < minG) minG = c[1]; if (c[1] > maxG) maxG = c[1];
            if (c[2] < minB) minB = c[2]; if (c[2] > maxB) maxB = c[2];
        }
        const rangeR = maxR - minR, rangeG = maxG - minG, rangeB = maxB - minB;
        const channel = rangeR >= rangeG && rangeR >= rangeB ? 0 : (rangeG >= rangeB ? 1 : 2);

        bucket.sort((a, b) => a[channel] - b[channel]);
        const mid = Math.floor(bucket.length / 2);
        return [
            ...splitBucket(bucket.slice(0, mid), depth - 1),
            ...splitBucket(bucket.slice(mid), depth - 1)
        ];
    }

    const depth = Math.ceil(Math.log2(colorCount));
    const buckets = splitBucket(colors, depth).slice(0, colorCount);

    // 每个桶取平均色作为调色板
    const palette = buckets.filter(b => b.length > 0).map(bucket => {
        let r = 0, g = 0, b = 0;
        for (const c of bucket) { r += c[0]; g += c[1]; b += c[2]; }
        const n = bucket.length;
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });

    return palette;
}

// 找到调色板中最近的颜色
function findClosestColor(r, g, b, palette) {
    let minDist = Infinity, closest = palette[0];
    for (const c of palette) {
        const dr = r - c[0], dg = g - c[1], db = b - c[2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < minDist) { minDist = dist; closest = c; }
    }
    return closest;
}

// 转换为像素画（支持颜色量化 + 更大像素块更清晰）
function convertToPixel() {
    if (!appState.convertFile) {
        alert('请先上传一张图片');
        return;
    }
    
    const pixelCanvas = document.getElementById('pixelCanvas');
    const colorCountInput = document.getElementById('colorCountInput');
    const resolutionInput = document.getElementById('resolutionInput');
    const colorCount = Math.max(24, Math.min(256, parseInt(colorCountInput.value) || 24));
    const maxSize = Math.max(20, Math.min(200, parseInt(resolutionInput.value) || 80));
    const gridSize = 12; // 每个像素格子的显示尺寸（固定值，保证网格清晰）
    const img = new Image();
    img.onload = () => {
        // 计算缩放比例
        const scale = Math.min(maxSize / img.width, maxSize / img.height);
        const pixelWidth = Math.max(1, Math.floor(img.width * scale));
        const pixelHeight = Math.max(1, Math.floor(img.height * scale));
        
        // 设置画布尺寸
        pixelCanvas.width = pixelWidth * gridSize;
        pixelCanvas.height = pixelHeight * gridSize;
        const ctx = pixelCanvas.getContext('2d');
        
        // 使用高质量缩放采样：先缩放到 2 倍大小再缩到目标，减少锯齿
        const sampleScale = 4; // 超采样倍率
        const sampleW = pixelWidth * sampleScale;
        const sampleH = pixelHeight * sampleScale;
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = sampleW;
        tempCanvas.height = sampleH;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.imageSmoothingEnabled = true;
        tempCtx.imageSmoothingQuality = 'high';
        tempCtx.drawImage(img, 0, 0, sampleW, sampleH);
        
        // 对每个像素块在超采样区域取平均色
        const sampleData = tempCtx.getImageData(0, 0, sampleW, sampleH).data;
        const pixelColors = [];
        
        for (let y = 0; y < pixelHeight; y++) {
            for (let x = 0; x < pixelWidth; x++) {
                let rSum = 0, gSum = 0, bSum = 0, aSum = 0, count = 0;
                for (let sy = y * sampleScale; sy < (y + 1) * sampleScale; sy++) {
                    for (let sx = x * sampleScale; sx < (x + 1) * sampleScale; sx++) {
                        const idx = (sy * sampleW + sx) * 4;
                        rSum += sampleData[idx];
                        gSum += sampleData[idx + 1];
                        bSum += sampleData[idx + 2];
                        aSum += sampleData[idx + 3];
                        count++;
                    }
                }
                pixelColors.push({
                    r: Math.round(rSum / count),
                    g: Math.round(gSum / count),
                    b: Math.round(bSum / count),
                    a: Math.round(aSum / count)
                });
            }
        }
        
        // 颜色量化（始终启用，最少24色）
        let palette = null;
        if (colorCount >= 24 && colorCount <= 256) {
            const flatPixels = new Uint8ClampedArray(pixelColors.length * 4);
            pixelColors.forEach((c, i) => {
                flatPixels[i * 4] = c.r;
                flatPixels[i * 4 + 1] = c.g;
                flatPixels[i * 4 + 2] = c.b;
                flatPixels[i * 4 + 3] = c.a;
            });
            palette = medianCutQuantize(flatPixels, colorCount);
        }
        
        // 绘制像素画
        for (let y = 0; y < pixelHeight; y++) {
            for (let x = 0; x < pixelWidth; x++) {
                const c = pixelColors[y * pixelWidth + x];
                let r = c.r, g = c.g, b = c.b;
                
                if (palette) {
                    const closest = findClosestColor(r, g, b, palette);
                    r = closest[0]; g = closest[1]; b = closest[2];
                }
                
                // 绘制像素块
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${c.a / 255})`;
                ctx.fillRect(x * gridSize, y * gridSize, gridSize, gridSize);
                
                // 绘制网格线
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
                ctx.lineWidth = 0.5;
                ctx.strokeRect(x * gridSize + 0.25, y * gridSize + 0.25, gridSize - 0.5, gridSize - 0.5);
            }
        }
        
        // 显示确认按钮
        document.getElementById('convertActions').style.display = 'flex';
        document.getElementById('confirmConvertBtn').style.display = 'block';
        document.getElementById('savePixelBtn').style.display = 'none';
        document.getElementById('uploadToGalleryBtn').style.display = 'none';
        appState.convertConfirmed = false;
    };
    img.src = appState.convertFile.dataUrl;
}

// 确认转换效果
function confirmConvert() {
    appState.convertConfirmed = true;
    document.getElementById('confirmConvertBtn').style.display = 'none';
    document.getElementById('savePixelBtn').style.display = 'block';
    document.getElementById('uploadToGalleryBtn').style.display = 'block';
}

// 上传转换后的图片到图库
function uploadToGallery() {
    if (!appState.convertFile || !appState.convertConfirmed) {
        alert('请先确认转换效果');
        return;
    }
    
    const pixelCanvas = document.getElementById('pixelCanvas');
    if (!pixelCanvas.width || !pixelCanvas.height) {
        alert('请先转换图片');
        return;
    }
    
    // 将像素画转换为dataUrl
    pixelCanvas.toBlob((blob) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const imageData = {
                id: Date.now() + Math.random(),
                name: `pixel_${appState.convertFile.name}`,
                dataUrl: e.target.result,
                tags: ['像素画', '转换'],
                keywords: ['像素画转换'],
                timestamp: Date.now()
            };
            
            if (appState.useServer) {
                // 服务器模式：上传到服务器
                uploadImage({
                    name: imageData.name,
                    dataUrl: imageData.dataUrl,
                    tags: imageData.tags,
                    keywords: imageData.keywords
                }).then(uploadedImage => {
                    appState.images.push(uploadedImage);
                    renderGallery();
                    alert('已上传至图库！');
                    resetConvertArea();
                }).catch(error => {
                    console.error('上传失败:', error);
                    alert('上传失败：' + error.message);
                });
            } else {
                // 本地模式：保存到IndexedDB
                appState.images.push(imageData);
                saveData().then(() => {
                    renderGallery();
                    alert('已上传至图库！');
                    resetConvertArea();
                }).catch(error => {
                    console.error('保存失败:', error);
                    alert('保存失败：' + error.message);
                });
            }
        };
        reader.readAsDataURL(blob);
    });
}

// 保存像素图
function savePixelImage() {
    const pixelCanvas = document.getElementById('pixelCanvas');
    if (!pixelCanvas.width || !pixelCanvas.height) {
        alert('请先转换图片');
        return;
    }
    
    if (!appState.convertConfirmed) {
        alert('请先确认转换效果');
        return;
    }
    
    const fileName = appState.convertFile ? `pixel_${appState.convertFile.name}` : 'pixel_art.png';
    
    pixelCanvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
    });
}

// 重置转换区域，方便继续转换下一张
function resetConvertArea() {
    appState.convertFile = null;
    appState.convertConfirmed = false;
    appState.currentImageForConvert = null;
    
    // 清空画布
    const originalCanvas = document.getElementById('originalCanvas');
    const pixelCanvas = document.getElementById('pixelCanvas');
    const origCtx = originalCanvas.getContext('2d');
    origCtx.clearRect(0, 0, originalCanvas.width, originalCanvas.height);
    originalCanvas.width = 0;
    originalCanvas.height = 0;
    const pixCtx = pixelCanvas.getContext('2d');
    pixCtx.clearRect(0, 0, pixelCanvas.width, pixelCanvas.height);
    pixelCanvas.width = 0;
    pixelCanvas.height = 0;
    
    // 隐藏预览、设置面板和按钮，显示上传区域
    document.getElementById('convertPreview').style.display = 'none';
    document.getElementById('convertActions').style.display = 'none';
    document.getElementById('convertSettings').style.display = 'none';
    document.getElementById('convertUploadArea').style.display = 'block';
    document.getElementById('convertFileInput').value = '';
}


// 切换选择模式
function toggleSelectMode() {
    appState.selectMode = !appState.selectMode;
    appState.selectedImages.clear();
    
    const selectionBar = document.getElementById('selectionBar');
    if (appState.selectMode) {
        document.getElementById('selectModeBtn').textContent = '取消选择';
        selectionBar.style.display = 'flex';
        selectionBar.classList.add('selection-bar--floating');
    } else {
        document.getElementById('selectModeBtn').textContent = '选择';
        selectionBar.style.display = 'none';
        selectionBar.classList.remove('selection-bar--floating');
    }
    
    renderGallery();
    updateSelectionBar();
}

// 取消选择模式
function cancelSelectMode() {
    appState.selectMode = false;
    appState.selectedImages.clear();
    document.getElementById('selectModeBtn').textContent = '选择';
    const selectionBar = document.getElementById('selectionBar');
    selectionBar.style.display = 'none';
    selectionBar.classList.remove('selection-bar--floating');
    renderGallery();
    updateSelectionBar();
}

// 更新选择栏
function updateSelectionBar() {
    const count = appState.selectedImages.size;
    document.getElementById('selectedCount').textContent = `已选择 ${count} 项`;
}

// 删除选中的图片
async function deleteSelected() {
    if (appState.selectedImages.size === 0) {
        alert('请先选择要删除的图片');
        return;
    }
    
    if (confirm(`确定要删除选中的 ${appState.selectedImages.size} 张图片吗？`)) {
        const idsToDelete = Array.from(appState.selectedImages);
        
        try {
            if (appState.useServer) {
                // 服务器模式：通过API删除
                await deleteImages(idsToDelete);
            } else {
                // 本地模式：从IndexedDB删除
                await deleteImages(idsToDelete);
            }
            
            // 从内存中移除（统一转为字符串比较，避免类型不一致）
            appState.images = appState.images.filter(img => !appState.selectedImages.has(String(img.id)));
            await saveData();
            cancelSelectMode();
            renderGallery();
        } catch (error) {
            console.error('删除失败:', error);
            alert('删除失败：' + error.message);
        }
    }
}

// 下载选中的图片
function downloadSelected() {
    if (appState.selectedImages.size === 0) {
        alert('请先选择要下载的图片');
        return;
    }
    
    appState.selectedImages.forEach(id => {
        const img = appState.images.find(i => String(i.id) === String(id));
        if (img && img.dataUrl) {
            const a = document.createElement('a');
            a.href = img.dataUrl;
            a.download = img.name || 'image';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    });
    
    cancelSelectMode();
}

// 路由功能
function initRouter() {
    handleRouteChange();
}

function handleRouteChange() {
    const hash = window.location.hash;
    if (hash && hash.startsWith('#/detail/')) {
        const imageId = hash.replace('#/detail/', '');
        showDetailPage(imageId);
    } else {
        showGalleryPage();
    }
}

function navigateToDetail(imageId) {
    window.location.hash = `#/detail/${imageId}`;
    showDetailPage(imageId);
}

function showDetailPage(imageId) {
    const img = appState.images.find(i => i.id == imageId);
    if (!img) {
        showGalleryPage();
        return;
    }
    
    // 隐藏图库页面
    document.querySelector('.container').style.display = 'none';
    // 显示详情页
    document.getElementById('detailPage').style.display = 'block';
    
    // 加载图片信息
    loadDetailPageData(img);
    
    // 添加鼠标滚轮缩放事件
    setupDetailImageZoom();
}

function showGalleryPage() {
    // 显示图库页面
    document.querySelector('.container').style.display = 'block';
    // 隐藏详情页
    document.getElementById('detailPage').style.display = 'none';
    
    // 刷新图库（确保勾选「已完成」后角标立即更新）
    renderGallery();
    
    // 恢复滚动位置
    if (appState.scrollPosition > 0) {
        setTimeout(() => {
            window.scrollTo(0, appState.scrollPosition);
        }, 100);
    }
    
    // 移除鼠标滚轮和拖拽事件
    removeDetailImageZoom();
}

function goBackToGallery() {
    window.history.back();
}

// 加载详情页数据
function loadDetailPageData(img) {
    const detailImage = document.getElementById('detailImage');
    const detailName = document.getElementById('detailName');
    const detailTags = document.getElementById('detailTags');
    const detailDimensions = document.getElementById('detailDimensions');
    const detailFormat = document.getElementById('detailFormat');
    const detailSize = document.getElementById('detailSize');
    
    // 设置图片
    detailImage.src = img.dataUrl;
    detailImage.onload = () => {
        // 获取图片实际尺寸
        const width = detailImage.naturalWidth;
        const height = detailImage.naturalHeight;
        detailDimensions.textContent = `${width} × ${height}`;
        
        // 重置缩放和平移
        appState.detailImageZoom = 100;
        appState.detailImagePan = { x: 0, y: 0 };
        detailImage.style.transform = 'scale(1) translate(0px, 0px)';
        
        // 确保图片适应容器（自动适应屏幕）
        const container = document.getElementById('detailImageContainer');
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        
        // 如果图片原始尺寸大于容器，自动缩放以适应
        if (width > containerWidth || height > containerHeight) {
            const scaleX = containerWidth / width;
            const scaleY = containerHeight / height;
            const scale = Math.min(scaleX, scaleY, 1); // 不超过100%
            detailImage.style.maxWidth = `${width * scale}px`;
            detailImage.style.maxHeight = `${height * scale}px`;
        }
    };
    
    // 设置名称
    detailName.textContent = img.name;
    
    // 设置标签
    detailTags.innerHTML = '';
    if (img.tags && img.tags.length > 0) {
        img.tags.forEach(tag => {
            const tagSpan = document.createElement('span');
            tagSpan.className = 'detail-tag';
            tagSpan.textContent = tag;
            detailTags.appendChild(tagSpan);
        });
    } else {
        detailTags.innerHTML = '<span style="color: rgba(255,255,255,0.5);">无标签</span>';
    }
    
    // 设置文件格式
    const format = img.name.split('.').pop().toUpperCase() || 'PNG';
    detailFormat.textContent = format;
    
    // 计算文件大小（估算）
    const base64Length = img.dataUrl.length;
    const sizeInBytes = (base64Length * 3) / 4;
    const sizeInKB = (sizeInBytes / 1024).toFixed(2);
    detailSize.textContent = `${sizeInKB} KB`;
    
    // 完成状态勾选（先更新本地状态再请求，失败则回滚）
    const checkbox = document.getElementById('detailCompletedCheckbox');
    if (checkbox) {
        const idStr = String(img.id);
        checkbox.checked = appState.completedImageIds.has(idStr);
        checkbox.onchange = null;
        checkbox.onchange = async () => {
            const completed = checkbox.checked;
            const prevHas = appState.completedImageIds.has(idStr);
            if (completed) appState.completedImageIds.add(idStr);
            else appState.completedImageIds.delete(idStr);
            try {
                if (appState.useServer) {
                    await setImageCompleted(idStr, completed);
                } else {
                    await saveCompletedIds(Array.from(appState.completedImageIds));
                }
            } catch (e) {
                console.error('完成状态保存失败:', e);
                if (prevHas) appState.completedImageIds.add(idStr);
                else appState.completedImageIds.delete(idStr);
                checkbox.checked = !completed;
                alert('保存失败，请稍后重试。\n' + (e && e.message ? e.message : ''));
            }
        };
    }
}

// 设置详情页图片缩放和拖动
function setupDetailImageZoom() {
    const detailImageContainer = document.getElementById('detailImageContainer');
    
    // 鼠标滚轮缩放
    detailImageContainer.addEventListener('wheel', handleDetailImageWheel, { passive: false });
    // 拖动浏览
    detailImageContainer.addEventListener('mousedown', handleDetailImageMouseDown);
    detailImageContainer.addEventListener('mousemove', handleDetailImageMouseMove);
    detailImageContainer.addEventListener('mouseup', handleDetailImageMouseUp);
    detailImageContainer.addEventListener('mouseleave', handleDetailImageMouseUp);
}

function removeDetailImageZoom() {
    const detailImageContainer = document.getElementById('detailImageContainer');
    detailImageContainer.removeEventListener('wheel', handleDetailImageWheel);
    detailImageContainer.removeEventListener('mousedown', handleDetailImageMouseDown);
    detailImageContainer.removeEventListener('mousemove', handleDetailImageMouseMove);
    detailImageContainer.removeEventListener('mouseup', handleDetailImageMouseUp);
    detailImageContainer.removeEventListener('mouseleave', handleDetailImageMouseUp);
}

function handleDetailImageWheel(e) {
    e.preventDefault();
    
    const detailImage = document.getElementById('detailImage');
    const delta = e.deltaY > 0 ? -10 : 10;
    
    appState.detailImageZoom = Math.max(25, Math.min(500, appState.detailImageZoom + delta));
    applyDetailImageTransform(detailImage);
}

function handleDetailImageMouseDown(e) {
    if (e.button !== 0) return; // 只响应左键
    e.preventDefault();
    appState.detailImageDragging = true;
    appState.detailImageDragStart = { x: e.clientX - appState.detailImagePan.x, y: e.clientY - appState.detailImagePan.y };
    document.getElementById('detailImageContainer').style.cursor = 'grabbing';
}

function handleDetailImageMouseMove(e) {
    if (!appState.detailImageDragging) return;
    e.preventDefault();
    appState.detailImagePan.x = e.clientX - appState.detailImageDragStart.x;
    appState.detailImagePan.y = e.clientY - appState.detailImageDragStart.y;
    applyDetailImageTransform(document.getElementById('detailImage'));
}

function handleDetailImageMouseUp(e) {
    if (appState.detailImageDragging) {
        appState.detailImageDragging = false;
        document.getElementById('detailImageContainer').style.cursor = 'grab';
    }
}

function applyDetailImageTransform(img) {
    const scale = appState.detailImageZoom / 100;
    const tx = appState.detailImagePan.x;
    const ty = appState.detailImagePan.y;
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.style.transition = 'none';
}
