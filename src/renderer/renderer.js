const { ipcRenderer } = require('electron');

class SteamLibraryUI {
    constructor() {
        this.currentPage = 'home';
        this.currentCategory = 'featured';
        this.currentGameData = null;
        this.gamesData = [];
        this.libraryGames = [];
        this.config = {};
        this.restartCountdown = null;
        this.searchTimeout = null;
        this.countryCode = null;
        
        // Online Pass sayfalama değişkenleri
        this.onlinePassGames = [];
        this.onlinePassCurrentPage = 0;
        this.onlinePassGamesPerPage = 15;
        this.onlinePassFilteredGames = [];
        
        this.init();
    }

    async init() {
        await this.detectCountryCode();
        this.setupEventListeners();
        await this.loadConfig();
        await this.checkSteamPath();
        this.loadGames();
        this.loadLibrary();
        this.setupKeyboardShortcuts();
    }

    async detectCountryCode() {
        // Önce localStorage'da var mı bak
        let cc = localStorage.getItem('countryCode');
        if (cc) {
            this.countryCode = cc;
            return;
        }
        // GeoJS ile ülke kodunu al
        try {
            const res = await fetch('https://get.geojs.io/v1/ip/country.json');
            const data = await res.json();
            if (data && data.country) {
                this.countryCode = data.country;
                localStorage.setItem('countryCode', data.country);
                return;
            }
        } catch (e) {
            this.countryCode = 'TR'; // fallback
        }
    }

    updateTranslations() {
        // Tüm data-i18n metinlerini güncelle
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            el.textContent = this.translate(key);
        });
        // Tüm data-i18n-placeholder alanlarını güncelle
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            el.setAttribute('placeholder', this.translate(key));
        });
        // Tüm data-i18n-title alanlarını güncelle
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            el.setAttribute('title', this.translate(key));
        });
    }

    setupEventListeners() {
        // Window controls
        document.getElementById('minimizeBtn').addEventListener('click', () => {
            ipcRenderer.invoke('window-minimize');
        });

        document.getElementById('maximizeBtn').addEventListener('click', () => {
            ipcRenderer.invoke('window-maximize');
        });

        document.getElementById('closeBtn').addEventListener('click', () => {
            ipcRenderer.invoke('window-close');
        });

        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => {
                this.switchPage(item.dataset.page);
            });
        });

        // Filter tabs
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchCategory(tab.dataset.category);
            });
        });

        // Search
        const searchInput = document.getElementById('searchInput');
        searchInput.addEventListener('input', (e) => {
            // Eğer aktif sayfa onlinePass ise, online oyunlarda filtrele
            if (this.getCurrentPage() === 'onlinePass') {
                const query = e.target.value.trim().toLowerCase();
                if (!this.onlinePassGames) return;
                if (!query) {
                    this.onlinePassFilteredGames = this.onlinePassGames;
                    this.onlinePassCurrentPage = 0;
                    this.renderOnlinePassGames();
                } else {
                    this.onlinePassFilteredGames = this.onlinePassGames.filter(game => game.name.toLowerCase().includes(query));
                    this.onlinePassCurrentPage = 0;
                    this.renderOnlinePassGames();
                }
            } else {
                this.handleSearch(e.target.value, false);
            }
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (this.getCurrentPage() === 'onlinePass') {
                    // Enter'a basınca da filtrele
                    const query = searchInput.value.trim().toLowerCase();
                    if (!this.onlinePassGames) return;
                    if (!query) {
                        this.onlinePassFilteredGames = this.onlinePassGames;
                        this.onlinePassCurrentPage = 0;
                        this.renderOnlinePassGames();
                    } else {
                        this.onlinePassFilteredGames = this.onlinePassGames.filter(game => game.name.toLowerCase().includes(query));
                        this.onlinePassCurrentPage = 0;
                        this.renderOnlinePassGames();
                    }
                } else {
                    this.handleSearch(e.target.value, true);
                }
            }
        });


        

        // Settings
        document.getElementById('browseSteamBtn').addEventListener('click', () => {
            this.selectSteamPath();
        });

        document.getElementById('setupBrowseBtn').addEventListener('click', () => {
            this.selectSteamPath();
        });

        document.getElementById('confirmSetupBtn').addEventListener('click', () => {
            this.confirmSteamSetup();
        });

        // Modal controls
        document.getElementById('modalClose').addEventListener('click', () => {
            this.closeModal('gameModal');
        });

        document.getElementById('dlcModalClose').addEventListener('click', () => {
            this.closeModal('dlcModal');
        });

        // Steam restart
        const restartBtn = document.getElementById('restartSteamBtn');
        if (restartBtn) restartBtn.addEventListener('click', () => {
            this.restartSteam();
        });

        const cancelRestartBtn = document.getElementById('cancelRestartBtn');
        if (cancelRestartBtn) cancelRestartBtn.addEventListener('click', () => {
            this.closeModal('steamRestartModal');
        });

        // Library refresh
        const refreshLibraryBtn = document.getElementById('refreshLibraryBtn');
        if (refreshLibraryBtn) refreshLibraryBtn.addEventListener('click', () => {
            this.refreshLibrary();
        });

        // Load more games
        const loadMoreBtn = document.getElementById('loadMoreBtn');
        if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => {
            this.loadMoreGames();
        });

        // Settings toggles
        const discordToggle = document.getElementById('discordRPCToggle');
        if (discordToggle) discordToggle.addEventListener('change', (e) => {
            this.updateConfig({ discordRPC: e.target.checked });
        });
        const videoMutedToggle = document.getElementById('videoMutedToggle');
        if (videoMutedToggle) videoMutedToggle.addEventListener('change', (e) => {
            this.updateConfig({ videoMuted: e.target.checked });
        });



        // Close modals on overlay click
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    this.closeModal(overlay.id);
                }
            });
        });

        // Hamburger menü ve baloncuklar
        const hamburgerBtn = document.getElementById('hamburgerMenuBtn');
        const bubbleMenu = document.getElementById('bubbleMenu');
        hamburgerBtn.addEventListener('click', () => {
            bubbleMenu.classList.toggle('active');
        });
        // Baloncuklara tıklama
        document.getElementById('bubbleSettings').addEventListener('click', () => {
            this.switchPage('settings');
            bubbleMenu.classList.remove('active');
        });
        document.getElementById('bubbleHome').addEventListener('click', () => {
            this.switchPage('home');
            bubbleMenu.classList.remove('active');
        });
        document.getElementById('bubbleLibrary').addEventListener('click', () => {
            this.switchPage('library');
            bubbleMenu.classList.remove('active');
        });
        document.getElementById('bubbleOnlinePass').addEventListener('click', () => {
            this.switchPage('onlinePass');
            bubbleMenu.classList.remove('active');
        });
        document.getElementById('bubbleManualInstall').addEventListener('click', () => {
            this.switchPage('manualInstall');
            bubbleMenu.classList.remove('active');
        });



        

        // Dil seçici butonları
        const langBtns = document.querySelectorAll('.lang-btn');
        const selectedLang = localStorage.getItem('selectedLang') || 'tr';
        langBtns.forEach(btn => {
            if (btn.dataset.lang === selectedLang) btn.classList.add('selected');
            btn.addEventListener('click', () => {
                langBtns.forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                localStorage.setItem('selectedLang', btn.dataset.lang);
                this.updateTranslations();
            });
        });
        // Sayfa ilk açıldığında da çevirileri uygula
        this.updateTranslations();
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'k') {
                e.preventDefault();
                document.getElementById('searchInput').focus();
            }
            
            if (e.key === 'Escape') {
                this.closeAllModals();
            }
        });
    }

    async loadConfig() {
        try {
            this.config = await ipcRenderer.invoke('get-config');
            this.updateSettingsUI();
        } catch (error) {
            console.error('Failed to load config:', error);
            this.showNotification('error', 'config_load_failed', 'error');
        }
    }

    async updateConfig(updates) {
        try {
            this.config = await ipcRenderer.invoke('save-config', updates);
            this.showNotification('success', 'settings_saved', 'success');
        } catch (error) {
            console.error('Failed to update config:', error);
            this.showNotification('error', 'settings_save_failed', 'error');
        }
    }

    updateSettingsUI() {
        document.getElementById('steamPathInput').value = this.config.steamPath || '';
        const discordToggle = document.getElementById('discordRPCToggle');
        if (discordToggle) discordToggle.checked = this.config.discordRPC;
        const videoMutedToggle = document.getElementById('videoMutedToggle');
        if (videoMutedToggle) videoMutedToggle.checked = this.config.videoMuted;
    }

    async checkSteamPath() {
        if (!this.config.steamPath) {
            this.showModal('steamSetupModal');
        }
    }

    async selectSteamPath() {
        try {
            const steamPath = await ipcRenderer.invoke('select-steam-path');
            if (steamPath) {
                document.getElementById('steamPathInput').value = steamPath;
                document.getElementById('setupSteamPath').value = steamPath;
                this.showNotification('success', 'steam_path_set', 'success');
            }
        } catch (error) {
            console.error('Failed to select Steam path:', error);
            this.showNotification('error', 'steam_path_failed', 'error');
        }
    }

    confirmSteamSetup() {
        const steamPath = document.getElementById('setupSteamPath').value;
        if (steamPath) {
            this.closeModal('steamSetupModal');
            this.showNotification('Başarılı', 'Kurulum başarıyla tamamlandı', 'success');
        }
    }

    switchPage(page) {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
        const pageEl = document.getElementById(page + 'Page');
        if (pageEl) {
            pageEl.classList.add('active');
            pageEl.style.display = '';
            if (page === 'onlinePass') {
                this.loadOnlinePassGames();
            } else if (page === 'manualInstall') {
                this.setupManualInstallListeners();
            }
        }
    }

    switchCategory(category) {
        // Update filter tabs
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.classList.remove('active');
        });
        document.querySelector(`[data-category="${category}"]`).classList.add('active');

        // Update section title
        const categoryNames = {
            'featured': 'Öne Çıkan Oyunlar',
            'popular': 'Popüler Oyunlar',
            'new': 'Yeni Çıkan Oyunlar',
            'top': 'En İyi Oyunlar',
            'free': 'Ücretsiz Oyunlar',
            'action': 'Aksiyon Oyunları',
            'rpg': 'RPG Oyunları',
            'strategy': 'Strateji Oyunları'
        };
        
        document.getElementById('sectionTitle').textContent = categoryNames[category] || 'Oyunlar';

        this.currentCategory = category;
        this.loadGames();
    }

    // Kategori sistemi kaldırıldı, ana sayfa sadece belirli oyunları gösterir
    async loadGames() {
        let featuredAppIds = [1436990,2300230,2255360,2418490,2731550,2749880,2547320,3181470,1114860];
        for (let i = featuredAppIds.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [featuredAppIds[i], featuredAppIds[j]] = [featuredAppIds[j], featuredAppIds[i]];
        }
                this.showLoading();
                try {
            const cc = this.countryCode || 'TR';
            const lang = this.getSelectedLang();
            const games = await Promise.all(featuredAppIds.slice(0, 9).map(async appid => {
                const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&l=${lang}`);
                const data = await res.json();
                const gameData = data[appid]?.data;
                if (!gameData) return null;
                return {
                    appid: appid,
                    name: gameData.name,
                    header_image: gameData.header_image,
                    price: gameData.price_overview ? gameData.price_overview : 0,
                    discount_percent: gameData.price_overview ? gameData.price_overview.discount_percent : 0,
                    platforms: gameData.platforms,
                    coming_soon: gameData.release_date?.coming_soon,
                    tags: [],
                    short_description: gameData.short_description,
                    reviews: gameData.recommendations ? 'Çok Olumlu' : '',
                    is_dlc: false
                };
            }));
            this.gamesData = games.filter(Boolean);
            await this.renderGames();
            this.updateHeroSection();
        } catch (error) {
            console.error('Failed to load games:', error);
            this.showNotification('Hata', 'Oyunlar yüklenemedi', 'error');
        } finally {
            this.hideLoading();
        }
    }

    async renderGames() {
        const gamesGrid = document.getElementById('gamesGrid');
        gamesGrid.innerHTML = '';

        if (this.gamesData.length === 0) {
            gamesGrid.innerHTML = '<div class="no-games">Hiç oyun bulunamadı</div>';
            return;
        }

        // Oyun kartlarını paralel olarak oluştur
        const cardPromises = this.gamesData.map(game => this.createGameCard(game));
        const cards = await Promise.all(cardPromises);
        
        cards.forEach(card => {
            gamesGrid.appendChild(card);
        });
    }

    // Oyun kartı oluşturulurken butonlara data-i18n ekle
    async createGameCard(game, isLibrary = false) {
        const card = document.createElement('div');
        card.className = 'game-card';
        card.addEventListener('click', () => this.showGameDetails(game));

        // Akıllı görsel çekme sistemi
        let imageUrl = game.header_image;
        if (!imageUrl && game.appid) {
            imageUrl = await this.getGameImageUrl(game.appid, game.name);
        }

        const tagsHtml = game.tags ? game.tags.map(tag => 
            `<span class="game-tag" style="background-color: ${tag.color}">${tag.name}</span>`
        ).join('') : '';

        // Oyun kütüphanede mi kontrol et
        const isInLibrary = this.libraryGames && this.libraryGames.some(libGame => libGame.appid == game.appid);

        let actionsHtml = '';
        if (isInLibrary) {
            actionsHtml = `
                <button class="game-btn primary" data-i18n="start_game" onclick="event.stopPropagation(); ui.launchGame(${game.appid})">${this.translate('start_game')}</button>
                <button class="game-btn secondary" data-i18n="remove_game" onclick="event.stopPropagation(); ui.deleteGame(${game.appid})">${this.translate('remove_game')}</button>
            `;
        } else {
            actionsHtml = `
                <button class="game-btn primary" data-i18n="add_to_library" ${isInLibrary ? 'disabled' : ''} onclick="event.stopPropagation(); ${isInLibrary ? '' : `ui.addGameToLibrary(${game.appid})`}">${isInLibrary ? this.translate('already_added') : this.translate('add_to_library')}</button>
                <button class="game-btn secondary" data-i18n="steam_page" onclick="event.stopPropagation(); ui.openSteamPage(${game.appid})">${this.translate('steam_page')}</button>
            `;
        }

        // Fiyat ve indirim sadece kütüphane dışı kartlarda gösterilsin
        let priceHtml = '';
        if (!isLibrary) {
            let priceText = '';
            if (!game.price || game.price === 0 || game.price === '0') {
                priceText = this.translate('free');
            } else {
                // Para birimi ve sayı formatı
                let symbol = '₺';
                if (typeof game.price === 'object' && game.price.currency) {
                    const currency = game.price.currency;
                    symbol = currency === 'TRY' ? '₺' : (currency === 'USD' ? '$' : (currency === 'EUR' ? '€' : currency));
                    priceText = `${symbol}${(game.price.final / 100).toLocaleString(this.getSelectedLang(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                } else {
                    priceText = `${symbol}${(game.price / 100).toLocaleString(this.getSelectedLang(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                }
            }
            priceHtml = `<span class="game-price" style="font-size:16px;font-weight:600;">${priceText}</span>`;
            if (game.discount_percent > 0) {
                priceHtml += `<span class="game-discount">${game.discount_percent}% ${this.translate('discount')}</span>`;
            }
        }

        card.innerHTML = `
            <img src="${imageUrl}" alt="${game.name}" class="game-image" loading="lazy" style="width:100%;height:180px;object-fit:cover;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.18);">
            <div class="game-info">
                <h3 class="game-title" style="font-size:18px;font-weight:700;margin-bottom:4px;">${game.name}</h3>
                <div class="game-meta" style="margin-bottom:6px;">
                    ${priceHtml}
                </div>
                <div class="game-tags">${tagsHtml}</div>
                <div class="game-actions">${actionsHtml}</div>
            </div>
        `;

        return card;
    }

    // Hero alanında slayt
    async updateHeroSection() {
        if (this.gamesData.length === 0) return;
        let index = 0;
        const selectedLang = this.getSelectedLang();
        const cc = langToCountry[selectedLang] || selectedLang.toUpperCase() || 'US';
        const update = async () => {
            const featuredGame = this.gamesData[index];
        const heroTitle = document.getElementById('heroTitle');
        const heroDescription = document.getElementById('heroDescription');
        const heroPrice = document.getElementById('heroPrice');
        const heroBackground = document.getElementById('heroBackground');
        heroTitle.textContent = featuredGame.name;
            // Açıklamayı sade ve kısa göster
            let desc = '';
            try {
                const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${featuredGame.appid}&cc=${cc}&l=${selectedLang}`);
                const data = await res.json();
                const gameData = data[featuredGame.appid]?.data;
                desc = gameData?.short_description || '';
                // HTML etiketlerini temizle ve kısalt
                desc = desc.replace(/<[^>]+>/g, '').trim();
                if (desc.length > 200) desc = desc.slice(0, 200) + '...';
            } catch {}
            heroDescription.textContent = desc || this.translate('discovering_games');
            // Fiyat gösterimi
            let priceText = '';
            if (!featuredGame.price || featuredGame.price === 0 || featuredGame.price === '0') {
                priceText = this.translate('free');
            } else {
                let symbol = '₺';
                if (typeof featuredGame.price === 'object' && featuredGame.price.currency) {
                    const currency = featuredGame.price.currency;
                    symbol = currency === 'TRY' ? '₺' : (currency === 'USD' ? '$' : (currency === 'EUR' ? '€' : currency));
                    priceText = `${symbol}${(featuredGame.price.final / 100).toLocaleString(this.getSelectedLang(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                } else {
                    priceText = `${symbol}${(featuredGame.price / 100).toLocaleString(this.getSelectedLang(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                }
            }
            if (heroPrice) heroPrice.textContent = priceText;
        if (featuredGame.header_image) {
            heroBackground.style.backgroundImage = `url(${featuredGame.header_image})`;
        }
            // Butonlar
            const viewBtn = document.getElementById('heroViewBtn');
            const addBtn = document.getElementById('heroLibraryBtn');
            if (viewBtn) {
                viewBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.showGameDetails(featuredGame);
                };
                viewBtn.innerText = this.translate('view_details');
            }
            if (addBtn) {
                // Kütüphanede var mı kontrolü
                const isInLibrary = this.libraryGames && this.libraryGames.some(libGame => libGame.appid == featuredGame.appid);
                addBtn.disabled = isInLibrary;
                addBtn.innerText = isInLibrary ? this.translate('already_added') : this.translate('add_to_library');
                addBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (!isInLibrary) this.addGameToLibrary(featuredGame.appid);
                };
            }
            index = (index + 1) % this.gamesData.length;
        };
        await update();
        if (this.heroInterval) clearInterval(this.heroInterval);
        this.heroInterval = setInterval(update, 8000);
    }

    async showGameDetails(game) {
        this.showLoading();
        try {
            const selectedLang = this.getSelectedLang();
            const gameDetails = await ipcRenderer.invoke('fetch-game-details', game.appid, selectedLang);
            if (gameDetails) {
                this.currentGameData = gameDetails;
                this.renderGameModal(gameDetails);
                this.showModal('gameModal');
            }
        } catch (error) {
            console.error('Failed to load game details:', error);
            this.showNotification('Hata', 'Oyun detayları yüklenemedi', 'error');
        } finally {
            this.hideLoading();
        }
    }

    // Modal state temizliği için yardımcı fonksiyon
    clearGameModalState() {
        const mainImage = document.getElementById('modalMainImage');
        const videoContainer = document.getElementById('modalVideoContainer');
        const previewThumbnails = document.getElementById('modalPreviewThumbnails');
        if (mainImage) {
            mainImage.src = '';
            mainImage.style.display = 'none';
        }
        if (videoContainer) videoContainer.innerHTML = '';
        if (previewThumbnails) previewThumbnails.innerHTML = '';
    }

    async renderGameModal(game) {
        const selectedLang = this.getSelectedLang();
        let cc = langToCountry[selectedLang] || selectedLang.toUpperCase() || 'TR';
        let lang = selectedLang || 'turkish';
        if (!cc || cc.length !== 2) cc = 'TR';
        if (!lang) lang = 'turkish';
        const modal = document.getElementById('gameModal');
        const mainImage = document.getElementById('modalMainImage');
        const videoContainer = document.getElementById('modalVideoContainer');
        const previewThumbnails = document.getElementById('modalPreviewThumbnails');
        let videoEl = null;
        // Modern galeri/slider için medya dizisi oluştur
        let media = [];
        let hasVideo = game.movies && game.movies.length > 0 && game.movies[0].mp4;
        if (hasVideo) {
            media.push({ type: 'video', src: game.movies[0].mp4.max || game.movies[0].mp4[480] || '', thumb: game.movies[0].thumbnail || '', title: 'Video' });
        }
        media.push({ type: 'image', src: game.header_image, thumb: game.header_image, title: 'Kapak' });
        let screenshots = Array.isArray(game.screenshots) ? game.screenshots : [];
        screenshots.forEach((s, i) => {
            media.push({ type: 'image', src: s.path_full || s, thumb: s.path_thumbnail || s.path_full || s, title: `Ekran Görüntüsü ${i+1}` });
        });
        let activeIndex = 0;
        const config = this.config;
        // Galeri ana fonksiyonu
        const renderGallery = (idx) => {
            activeIndex = idx;
            // Temizle
            videoContainer.innerHTML = '';
            mainImage.style.display = 'none';
            // Aktif medya göster
            const item = media[activeIndex];
            if (item.type === 'video') {
                videoEl = document.createElement('video');
                videoEl.src = item.src;
                videoEl.controls = true;
                videoEl.className = 'modal-media-main';
                videoEl.style.width = '100%';
                videoEl.style.maxHeight = '340px';
                videoEl.style.objectFit = 'cover';
                videoEl.style.background = '#000';
                videoEl.autoplay = true;
                videoEl.muted = !!config.videoMuted;
                videoContainer.appendChild(videoEl);
            } else {
                mainImage.src = item.src;
                mainImage.className = 'modal-media-main';
                mainImage.style.display = 'block';
            }
            // Thumbnailları güncelle
            previewThumbnails.innerHTML = '';
            media.forEach((m, i) => {
                const thumb = document.createElement(m.type === 'video' ? 'button' : 'img');
                if (m.type === 'video') {
                    thumb.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21"/></svg>';
                    thumb.title = m.title;
                } else {
                    thumb.src = m.thumb;
                    thumb.title = m.title;
                }
                if (i === activeIndex) thumb.classList.add('active');
                thumb.onclick = () => renderGallery(i);
                previewThumbnails.appendChild(thumb);
            });
        };
        // Ok tuşları ile geçiş
        modal.onkeydown = (e) => {
            if (e.key === 'ArrowLeft') {
                renderGallery((activeIndex - 1 + media.length) % media.length);
            } else if (e.key === 'ArrowRight') {
                renderGallery((activeIndex + 1) % media.length);
            }
        };
        // Modal açıldığında focus al
        setTimeout(() => { modal.focus && modal.focus(); }, 200);
        // İlk medya göster
        renderGallery(0);
        // ... mevcut modal içeriği ve diğer alanlar ...
        document.getElementById('modalTitle').textContent = game.name;
        document.getElementById('modalDeveloper').textContent = game.developers ? game.developers.join(', ') : 'Bilinmiyor';
        document.getElementById('modalReleaseDate').textContent = game.release_date ? game.release_date.date : 'Bilinmiyor';
        // Dil seçenekleri ve açıklama
        // Açıklama alanı için sadece seçili dilde veri çek
        let descFound = false;
        let desc = '';
        const descEl = document.getElementById('modalDescription');
        if (descEl) descEl.classList.add('modal-description');
        // --- BURADAKİ TEKRAR TANIMLAMALARI SİLİYORUM ---
        // const selectedLang = this.getSelectedLang();
        // let cc = langToCountry[selectedLang] || selectedLang.toUpperCase() || 'TR';
        // let lang = selectedLang || 'turkish';
        // if (!cc || cc.length !== 2) cc = 'TR';
        // if (!lang) lang = 'turkish';
        // --- SONU ---
        try {
            const url = `https://store.steampowered.com/api/appdetails?appids=${game.appid}&cc=${cc}&l=${lang}`;
            const resLang = await safeSteamFetch(url);
            let descGameData;
            if (resLang.status === 403 && cc !== 'TR') {
                // fallback TR/turkish ile tekrar dene
                const fallbackRes = await safeSteamFetch(`https://store.steampowered.com/api/appdetails?appids=${game.appid}&cc=TR&l=turkish`);
                if (fallbackRes.ok) {
                    const dataLang = await fallbackRes.json();
                    descGameData = dataLang[game.appid]?.data;
                }
            } else if (resLang.ok) {
                const dataLang = await resLang.json();
                descGameData = dataLang[game.appid]?.data;
            }
            if (descGameData) {
                desc = descGameData.about_the_game || descGameData.detailed_description || descGameData.descriptions?.[lang] || descGameData.short_description || '';
                desc = desc.trim().replace(/^<br\s*\/?>|<br\s*\/?>$/gi, '');
                if (desc) {
                    if (/<[a-z][\s\S]*>/i.test(desc)) {
                        descEl.innerHTML = desc;
                    } else {
                        descEl.textContent = desc;
                    }
                    descFound = true;
                }
            }
        } catch {}
        // Google Translate fallback
        if (!descFound) {
            let fallbackDesc = '';
            if (game.about_the_game) fallbackDesc = game.about_the_game.trim();
            else if (game.detailed_description) fallbackDesc = game.detailed_description.trim();
            else if (game.descriptions && Object.values(game.descriptions).length > 0) fallbackDesc = Object.values(game.descriptions)[0].trim();
            else if (game.short_description) fallbackDesc = game.short_description.trim();
            if (fallbackDesc) {
                try {
                    const sl = 'en'; // varsayılan kaynak dil
                    const tl = selectedLang;
                    const translateRes = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(fallbackDesc)}`);
                    const translateData = await translateRes.json();
                    const translated = translateData[0]?.map(part => part[0]).join(' ');
                    if (/<[a-z][\s\S]*>/i.test(translated)) {
                        descEl.innerHTML = translated;
                    } else {
                        descEl.textContent = translated;
                    }
                    descFound = true;
                } catch {
                    descEl.textContent = this.translate('no_description');
                }
            } else {
                descEl.textContent = this.translate('no_description');
            }
        }
        // Oyun detay bilgilerini estetik göster
        const dev = game.developers ? game.developers.join(', ') : 'Bilinmiyor';
        const pub = game.publishers ? game.publishers.join(', ') : 'Bilinmiyor';
        const release = game.release_date ? game.release_date.date : 'Bilinmiyor';
        const modalDevDetail = document.getElementById('modalDevDetail');
        if (modalDevDetail) modalDevDetail.textContent = dev;
        const modalPublisher = document.getElementById('modalPublisher');
        if (modalPublisher) modalPublisher.textContent = pub;
        const modalRelease = document.getElementById('modalRelease');
        if (modalRelease) modalRelease.textContent = release;
        // İncelemeler çevirisi
        const reviewsContainer = document.getElementById('modalReviews');
        let reviewText = game.reviews || '';
        if (reviewText) {
            // Eğer seçili dilde değilse Google Translate ile çevir
            try {
                const sl = 'en'; // varsayılan kaynak dil
                const tl = selectedLang;
                const translateRes = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(reviewText)}`);
                const translateData = await translateRes.json();
                const translated = translateData[0]?.map(part => part[0]).join(' ');
                reviewsContainer.textContent = translated;
            } catch {
                reviewsContainer.textContent = reviewText;
            }
        } else {
            reviewsContainer.textContent = '';
        }
        // Değerlendirme (rating) alanını kaldır
        const ratingEl = document.getElementById('modalRating');
        if (ratingEl && ratingEl.parentElement) {
            ratingEl.parentElement.style.display = 'none';
        }
        // Render genres
        const genresContainer = document.getElementById('modalGenres');
        genresContainer.innerHTML = '';
        if (game.genres) {
            game.genres.forEach(genre => {
                const genreTag = document.createElement('span');
                genreTag.className = 'genre-tag';
                genreTag.textContent = genre.description;
                genresContainer.appendChild(genreTag);
            });
        }
        // Update modal buttons
        const addBtn = document.getElementById('modalAddBtn');
        const steamBtn = document.getElementById('modalSteamBtn');
        const startBtn = document.getElementById('modalStartBtn');
        const isInLibrary = this.libraryGames && this.libraryGames.some(libGame => libGame.appid == game.appid);
        if (addBtn) {
            addBtn.style.display = isInLibrary ? 'none' : '';
            addBtn.textContent = this.translate('add_to_library');
            addBtn.disabled = isInLibrary;
            // Eski event'leri temizle, yeni buton oluştur
            const newBtn = addBtn.cloneNode(true);
            addBtn.parentNode.replaceChild(newBtn, addBtn);
            newBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!isInLibrary) this.addGameToLibrary(game.appid);
            });
        }
        if (startBtn) {
            startBtn.style.display = isInLibrary ? '' : 'none';
            startBtn.textContent = this.translate('start_game');
            startBtn.disabled = !isInLibrary;
            startBtn.onclick = (e) => {
                e.stopPropagation();
                if (isInLibrary) this.launchGame(game.appid);
            };
        }
        if (steamBtn) steamBtn.textContent = this.translate('open_in_steam');
        // Fiyat gösterimi (düzeltildi)
        const priceEl = document.getElementById('modalPrice');
        if (priceEl) {
            let priceText = '';
            if (!game.price || game.price === 0 || game.price === '0') {
                priceText = this.translate('free');
            } else if (typeof game.price === 'object' && game.price.final) {
                // Steam API price objesi
                let currency = game.price.currency || 'TRY';
                let symbol = currency === 'TRY' ? '₺' : (currency === 'USD' ? '$' : (currency === 'EUR' ? '€' : currency));
                priceText = `${symbol}${(game.price.final / 100).toFixed(2)}`;
            } else if (!isNaN(game.price)) {
                // Sadece sayı ise
                let symbol = '₺';
                priceText = `${symbol}${(game.price / 100).toFixed(2)}`;
            } else {
                priceText = this.translate('free');
            }
            priceEl.textContent = priceText;
        }
    }

    async addGameToLibrary(appId) {
        if (!this.config.steamPath) {
            this.showNotification('error', 'steam_path_failed', 'error');
            return;
        }
        // Oyun dosyası API kontrolü (404 ise oyun yok)
        try {
            const res = await fetch(`https://muhammetdag.com/api/v1/game.php?steamid=${appId}`);
            if (res.status === 404) {
                this.showNotification('error', 'game_not_found', 'error');
                return;
            }
        } catch {
            this.showNotification('error', 'game_not_found', 'error');
            return;
        }
        // Check if game has DLCs ve oyun dosyası var mı kontrolü
        const gameDetails = await ipcRenderer.invoke('fetch-game-details', appId);
        if (!gameDetails || !gameDetails.appid) {
            this.showNotification('error', 'game_not_found', 'error');
            return;
        }
        if (gameDetails && gameDetails.dlc && gameDetails.dlc.length > 0) {
            // DLC ekranı açılır, kullanıcı seçim yapmazsa ana oyun yine de eklenmeli
            this.showDLCSelection(gameDetails, appId);
            return;
        }
        // Add game without DLCs
        this.showLoading();
        try {
            const result = await ipcRenderer.invoke('add-game-to-library', appId, []);
            if (result.success) {
                this.showNotification('success', 'game_added', 'success');
                this.closeModal('gameModal');
                this.showSteamRestartDialog();
            }
        } catch (error) {
            console.error('Failed to add game:', error);
            this.showNotification('error', 'game_add_failed', 'error');
        } finally {
            this.hideLoading();
        }
    }

    // DLC seçim ekranı: Kullanıcı modalı kapatırsa ana oyun eklensin
    showDLCSelection(gameDetails, appId) {
        const dlcList = document.getElementById('dlcList');
        dlcList.innerHTML = '';
        const selectedLang = this.getSelectedLang();
        let cc = langToCountry[selectedLang] || selectedLang.toUpperCase() || 'TR';
        let lang = selectedLang || 'turkish';
        if (!cc || cc.length !== 2) cc = 'TR';
        if (!lang) lang = 'turkish';
        const selectAllCheckbox = document.getElementById('selectAllDLC');
        let selectedDLCs = new Set();
        const grid = document.createElement('div');
        grid.className = 'dlc-grid';
        Promise.all((gameDetails.dlc || []).map(async dlcId => {
            try {
                const url = `https://store.steampowered.com/api/appdetails?appids=${dlcId}&cc=${cc}&l=${lang}`;
                const res = await safeSteamFetch(url);
                if (res.status === 403 && cc !== 'TR') {
                    const fallbackRes = await safeSteamFetch(`https://store.steampowered.com/api/appdetails?appids=${dlcId}&cc=TR&l=turkish`);
                    if (!fallbackRes.ok) return null;
                    const data = await fallbackRes.json();
                    var dlc = data[dlcId]?.data;
                } else {
                    if (!res.ok) return null;
                    const data = await res.json();
                    var dlc = data[dlcId]?.data;
                }
                if (!dlc) return null;
                let title = dlc.name || '';
                let desc = dlc.short_description || '';
                if (!desc) {
                    try {
                        const sl = 'en';
                        const tl = lang;
                        const translateRes = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(dlc.name)}`);
                        const translateData = await translateRes.json();
                        title = translateData[0]?.map(part => part[0]).join(' ');
                    } catch {}
                }
                if (!desc) {
                    try {
                        const sl = 'en';
                        const tl = lang;
                        const translateRes = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(dlc.short_description || dlc.name)}`);
                        const translateData = await translateRes.json();
                        desc = translateData[0]?.map(part => part[0]).join(' ');
                    } catch {}
                }
                let priceText = '';
                if (!dlc.price_overview || dlc.price_overview.final === 0) {
                    priceText = this.translate('dlc_free');
                } else {
                    let symbol = '₺';
                    const currency = dlc.price_overview.currency;
                    symbol = currency === 'TRY' ? '₺' : (currency === 'USD' ? '$' : (currency === 'EUR' ? '€' : currency));
                    priceText = `${symbol}${(dlc.price_overview.final / 100).toLocaleString(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                }
                const release = dlc.release_date?.date || '';
                const card = document.createElement('div');
                card.className = 'dlc-card';
                card.style.position = 'relative';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'dlc-select-checkbox';
                checkbox.style.position = 'absolute';
                checkbox.style.top = '12px';
                checkbox.style.left = '12px';
                checkbox.value = dlcId;
                checkbox.addEventListener('change', (e) => {
                    if (e.target.checked) {
                        selectedDLCs.add(dlcId);
                    } else {
                        selectedDLCs.delete(dlcId);
                    }
                    if (selectAllCheckbox) {
                        const allCheckboxes = grid.querySelectorAll('.dlc-select-checkbox');
                        selectAllCheckbox.checked = Array.from(allCheckboxes).every(cb => cb.checked);
                    }
                });
                card.appendChild(checkbox);
                card.innerHTML += `
                    <img src="${dlc.header_image}" alt="${title}" class="dlc-image" />
            <div class="dlc-info">
                        <div class="dlc-title">${title}</div>
                        <div class="dlc-desc">${desc}</div>
                        <div class="dlc-meta">
                            <span class="dlc-price">${priceText}</span>
                            <span class="dlc-release">${release}</span>
            </div>
                </div>
            `;
                return card;
            } catch {
                return null;
            }
        })).then(cards => {
            cards.filter(Boolean).forEach(card => grid.appendChild(card));
            dlcList.appendChild(grid);
            this.closeModal('gameModal');
            this.showModal('dlcModal');
            if (selectAllCheckbox) {
                selectAllCheckbox.checked = false;
                selectAllCheckbox.onchange = () => {
                    const allCheckboxes = grid.querySelectorAll('.dlc-select-checkbox');
                    allCheckboxes.forEach(cb => {
                        cb.checked = selectAllCheckbox.checked;
                        if (cb.checked) {
                            selectedDLCs.add(cb.value);
                        } else {
                            selectedDLCs.delete(cb.value);
                        }
                    });
                };
            }
            const confirmBtn = document.getElementById('confirmDLCBtn');
            const cancelBtn = document.getElementById('cancelDLCBtn');
            if (confirmBtn) {
                confirmBtn.onclick = () => {
                    this.confirmGameWithDLCs(gameDetails.appid, Array.from(selectedDLCs));
                };
            }
            if (cancelBtn) {
                cancelBtn.onclick = () => {
                    // Kullanıcı DLC modalını kapatırsa ana oyun yine de eklensin
                    this.confirmGameWithDLCs(gameDetails.appid, []);
                    this.closeModal('dlcModal');
                };
            }
        });
    }

    showSteamRestartDialog() {
        this.showModal('steamRestartModal');
        this.startRestartCountdown();
    }

    startRestartCountdown() {
        let seconds = 5;
        const countdownElement = document.getElementById('countdown');
        
        this.restartCountdown = setInterval(() => {
            countdownElement.textContent = seconds;
            seconds--;
            
            if (seconds < 0) {
                clearInterval(this.restartCountdown);
                this.restartSteam();
            }
        }, 1000);
    }

    async restartSteam() {
        if (this.restartCountdown) {
            clearInterval(this.restartCountdown);
        }
        
        try {
            await ipcRenderer.invoke('restart-steam');
            this.showNotification('Başarılı', 'Steam yeniden başlatılıyor', 'success');
            this.closeModal('steamRestartModal');
        } catch (error) {
            console.error('Failed to restart Steam:', error);
            this.showNotification('Hata', 'Steam yeniden başlatılamadı', 'error');
        }
    }

    async loadLibrary() {
        try {
            this.libraryGames = await ipcRenderer.invoke('get-library-games');
            this.renderLibrary();
        } catch (error) {
            console.error('Failed to load library:', error);
            this.showNotification('Hata', 'Kütüphane yüklenemedi', 'error');
        }
    }

    async refreshLibrary() {
        const refreshBtn = document.getElementById('refreshLibraryBtn');
        if (refreshBtn) {
            refreshBtn.classList.add('loading');
        }
        
        try {
            this.showNotification('info', 'refreshing_library', 'info');
            this.libraryGames = await ipcRenderer.invoke('get-library-games');
            this.renderLibrary();
            this.showNotification('success', 'library_refreshed', 'success');
        } catch (error) {
            console.error('Failed to refresh library:', error);
            this.showNotification('error', 'library_refresh_failed', 'error');
        } finally {
            if (refreshBtn) {
                refreshBtn.classList.remove('loading');
            }
        }
    }

    renderLibrary() {
        const libraryGrid = document.getElementById('libraryGrid');
        const libraryCount = document.getElementById('libraryCount');
        libraryCount.textContent = this.libraryGames.length;
        libraryGrid.innerHTML = '';

        if (this.libraryGames.length === 0) {
            libraryGrid.innerHTML = '<div class="no-games">Kütüphanenizde henüz oyun yok</div>';
            return;
        }

        this.libraryGames.forEach(game => {
            const gameCard = this.createGameCard(game, true); // kütüphane için ikinci parametre true
            libraryGrid.appendChild(gameCard);
        });
    }

    openSteamPage(appId) {
        ipcRenderer.invoke('open-external', `https://store.steampowered.com/app/${appId}`);
    }

    async loadMoreGames() {
        const cc = this.countryCode || 'TR';
        const lang = this.getSelectedLang();
        this.showLoading();
        try {
            // Popüler oyunları Steam'den çek
            const offset = this.gamesData.length;
            const resultsUrl = `https://store.steampowered.com/search/results?sort_by=Reviews_DESC&category1=998&force_infinite=1&start=${offset}&count=11&supportedlang=turkish&ndl=1&snr=1_7_7_151_7`;
            const html = await (await fetch(resultsUrl)).text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const rows = doc.querySelectorAll('.search_result_row');
            // Her oyun için detay çek
            const newGamesRaw = Array.from(rows).map(row => {
                const appid = row.getAttribute('data-ds-appid');
                const name = row.querySelector('.title')?.textContent?.trim() || '';
                return { appid, name };
            });
            // Aynı oyun tekrar eklenmesin
            const existingAppIds = new Set(this.gamesData.map(g => String(g.appid)));
            const filteredGames = newGamesRaw.filter(g => !existingAppIds.has(String(g.appid)));
            // Her oyun için detaylı veri çek
            const newGames = await Promise.all(filteredGames.slice(0, 11).map(async g => {
                try {
                    const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${g.appid}&cc=${cc}&l=${lang}`);
                    const data = await res.json();
                    const gameData = data[g.appid]?.data;
                    if (!gameData) return null;
                    return {
                        appid: g.appid,
                        name: gameData.name,
                        header_image: gameData.header_image,
                        price: gameData.price_overview ? gameData.price_overview.final : 0,
                        discount_percent: gameData.price_overview ? gameData.price_overview.discount_percent : 0,
                        platforms: gameData.platforms,
                        coming_soon: gameData.release_date?.coming_soon,
                        tags: [],
                        short_description: gameData.short_description,
                        reviews: gameData.recommendations ? 'Çok Olumlu' : '',
                        is_dlc: false
                    };
                } catch {
                    return null;
                }
            }));
            this.gamesData = this.gamesData.concat(newGames.filter(Boolean));
            this.renderGames();
            this.updateHeroSection();
        } finally {
            this.hideLoading();
        }
    }

    showModal(modalId) {
        const modal = document.getElementById(modalId);
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        modal.classList.remove('active');
        document.body.style.overflow = 'auto';
        
        if (modalId === 'steamRestartModal' && this.restartCountdown) {
            clearInterval(this.restartCountdown);
        }
        // Oyun detay modalı kapatılırken state temizle
        if (modalId === 'gameModal') {
            this.clearGameModalState();
        }
    }

    closeAllModals() {
        document.querySelectorAll('.modal-overlay').forEach(modal => {
            modal.classList.remove('active');
        });
        document.body.style.overflow = 'auto';
        
        if (this.restartCountdown) {
            clearInterval(this.restartCountdown);
        }
    }

    showLoading() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.classList.add('active');
            overlay.style.display = 'flex';
        }
        const loadingText = document.querySelector('.loading-text');
        if (loadingText) loadingText.textContent = this.translate('loading_games');
    }

    hideLoading() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.classList.remove('active');
            overlay.style.display = 'none';
        }
    }

    showNotification(title, message, type = 'info') {
        // Bildirim başlık ve mesajını çeviriyle göster
        const notifTitle = this.translate(title) || title;
        const notifMsg = this.translate(message) || message;
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `
            <div class="notification-title">${notifTitle}</div>
            <div class="notification-message">${notifMsg}</div>
        `;
        document.getElementById('notificationContainer').appendChild(notification);
        setTimeout(() => {
            notification.remove();
        }, 3500);
    }

    launchGame(appId) {
        // Steam'de oyunu başlat
        ipcRenderer.invoke('open-external', `steam://run/${appId}`);
        this.showNotification('success', 'Oyun Steam üzerinden başlatılıyor...', 'success');
    }

    async deleteGame(appId) {
        this.showLoading();
        try {
            const result = await ipcRenderer.invoke('delete-game', appId);
            if (result.success) {
                this.showNotification('success', 'game_deleted', 'success');
                await this.loadLibrary();
            } else {
                this.showNotification('error', result.error || 'game_delete_failed', 'error');
            }
        } catch (error) {
            this.showNotification('error', 'game_delete_failed', 'error');
        } finally {
            this.hideLoading();
        }
    }

    // handleSearch fonksiyonunu güncelle: enterPressed parametresi ekle
    handleSearch(query, enterPressed = false) {
        const cc = this.countryCode || 'TR';
        const lang = this.getSelectedLang();
        const heroSection = document.getElementById('heroSection');
        if (!enterPressed && (!query || query.length < 2)) {
            this.loadGames();
            if (heroSection) heroSection.style.display = '';
            // Geri Dön butonunu kaldır
            const backBtn = document.getElementById('searchBackBtn');
            if (backBtn) backBtn.remove();
            return;
        }
        if (this.searchTimeout) {
            clearTimeout(this.searchTimeout);
        }
        this.searchTimeout = setTimeout(async () => {
            const gamesGrid = document.getElementById('gamesGrid');
            // Geri Dön butonunu ekle
            let backBtn = document.getElementById('searchBackBtn');
            if (!backBtn) {
                backBtn = document.createElement('button');
                backBtn.id = 'searchBackBtn';
                backBtn.className = 'back-btn';
                backBtn.innerText = '⟵ Geri Dön';
                backBtn.style = 'margin-bottom: 16px; margin-left: 8px; font-size: 16px; padding: 6px 18px; border-radius: 8px; background: #222; color: #fff; border: none; cursor: pointer;';
                backBtn.onclick = () => {
                    this.loadGames();
                    if (heroSection) heroSection.style.display = '';
                    backBtn.remove();
                };
                // gamesGrid'in üstüne ekle
                gamesGrid.parentNode.insertBefore(backBtn, gamesGrid);
            }
            if (query.trim()) {
                this.showLoading();
                gamesGrid.innerHTML = '<div class="no-games">Aranıyor...';
                if (heroSection) heroSection.style.display = 'none';
                try {
                    let games = [];
                    if (/^\d+$/.test(query.trim())) {
                        // Appid ile arama
                        const url = `https://store.steampowered.com/api/appdetails?appids=${query.trim()}&cc=${cc}&l=${lang}`;
                        const res = await fetch(url);
                        const data = await res.json();
                        const gameData = data[query.trim()]?.data;
                        if (!gameData) throw new Error('Oyun bulunamadı');
                        games = [{
                            appid: query.trim(),
                            name: gameData.name,
                            header_image: gameData.header_image,
                            price: gameData.price_overview ? gameData.price_overview.final : 0,
                            discount_percent: gameData.price_overview ? gameData.price_overview.discount_percent : 0,
                            platforms: gameData.platforms,
                            coming_soon: gameData.release_date?.coming_soon,
                            short_description: gameData.short_description,
                            reviews: gameData.recommendations ? 'Çok Olumlu' : '',
                            is_dlc: false
                        }];
                    } else {
                        // Steam search results endpoint ile isimle arama
                        const searchTerm = encodeURIComponent(query.trim());
                        const resultsUrl = `https://store.steampowered.com/search/results?term=${searchTerm}&force_infinite=1&supportedlang=turkish&ndl=1&snr=1_7_7_151_7`;
                        const html = await (await fetch(resultsUrl)).text();
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(html, 'text/html');
                        const rows = doc.querySelectorAll('.search_result_row');
                        // Her oyun için ayrıca header_image çek
                        const gamesRaw = Array.from(rows).map(row => {
                            const appid = row.getAttribute('data-ds-appid');
                            const name = row.querySelector('.title')?.textContent?.trim() || '';
                            const priceEl = row.querySelector('.search_price');
                            let price = 0;
                            let discount_percent = 0;
                            if (priceEl) {
                                const priceText = priceEl.textContent.replace(/\n/g, '').replace(/\s+/g, ' ').trim();
                                const match = priceText.match(/([\d,.]+) TL/);
                                if (match) price = parseFloat(match[1].replace(',', '.')) * 100;
                                const discountEl = row.querySelector('.search_discount span');
                                if (discountEl) discount_percent = parseInt(discountEl.textContent.replace('%', '').replace('-', ''));
                            }
                            return {
                                appid,
                                name,
                                price,
                                discount_percent
                            };
                        });
                        // Her oyun için header_image çek
                        games = await Promise.all(gamesRaw.map(async g => {
                            try {
                                const detailRes = await fetch(`https://store.steampowered.com/api/appdetails?appids=${g.appid}&cc=${cc}&l=${lang}`);
                                const detailData = await detailRes.json();
                                const gameData = detailData[g.appid]?.data;
                                let header_image = gameData?.header_image;
                                if (!header_image) {
                                    header_image = `https://cdn.akamai.steamstatic.com/steam/apps/${g.appid}/capsule_616x353.jpg`;
                                }
                                return {
                                    appid: g.appid,
                                    name: g.name,
                                    header_image,
                                    price: g.price,
                                    discount_percent: g.discount_percent,
                                    platforms: {},
                                    coming_soon: false,
                                    tags: [],
                                    short_description: gameData?.short_description || '',
                                    reviews: '',
                                    is_dlc: false
                                };
                            } catch {
                                return null;
                            }
                        }));
                        if (!games.length) throw new Error('Oyun bulunamadı');
                    }
                    this.gamesData = games.filter(Boolean);
                    this.renderGames();
                } catch (error) {
                    let msg = error.message || 'Arama yapılamadı';
                    gamesGrid.innerHTML = `<div class=\"no-games\">${msg}</div>`;
                    this.showNotification('Hata', msg, 'error');
                    console.error('Arama hatası:', error);
                } finally {
                    this.hideLoading();
                }
            } else {
                this.loadGames();
                if (heroSection) heroSection.style.display = '';
            }
        }, 400);
    }

    // Basit çeviri sözlüğü ve translate fonksiyonu
    getSelectedLang() {
        return localStorage.getItem('selectedLang') || 'tr';
    }
    translate(key) {
        const lang = this.getSelectedLang();
        const dict = {
            'library': {
                tr: 'Kütüphanem', en: 'Library', de: 'Bibliothek', fr: 'Bibliothèque', es: 'Biblioteca', ru: 'Библиотека', zh: '库', ja: 'ライブラリ', it: 'Libreria', pt: 'Biblioteca', ko: '라이브러리', ar: 'المكتبة'
            },
            'settings': {
                tr: 'Ayarlar', en: 'Settings', de: 'Einstellungen', fr: 'Paramètres', es: 'Configuración', ru: 'Настройки', zh: '设置', ja: '設定', it: 'Impostazioni', pt: 'Configurações', ko: '설정', ar: 'الإعدادات'
            },
            'search_placeholder': {
                tr: 'Oyun ara...', en: 'Search game...', de: 'Spiel suchen...', fr: 'Rechercher un jeu...', es: 'Buscar juego...', ru: 'Поиск игры...', zh: '搜索游戏...', ja: 'ゲーム検索...', it: 'Cerca gioco...', pt: 'Buscar jogo...', ko: '게임 검색...', ar: 'ابحث عن لعبة...'
            },
            'add_to_library': {
                tr: 'Kütüphaneme Ekle', en: 'Add to Library', de: 'Zur Bibliothek', fr: 'Ajouter à la bibliothèque', es: 'Añadir a la biblioteca', ru: 'Добавить в библиотеку', zh: '添加到库', ja: 'ライブラリに追加', it: 'Aggiungi alla libreria', pt: 'Adicionar à biblioteca', ko: '라이브러리에 추가', ar: 'أضف إلى المكتبة'
            },
            'already_in_library': {
                tr: 'Zaten Sahipsiniz', en: 'Already Owned', de: 'Bereits vorhanden', fr: 'Déjà possédé', es: 'Ya en tu biblioteca', ru: 'Уже есть', zh: '已拥有', ja: 'すでに所有', it: 'Già posseduto', pt: 'Já possui', ko: '이미 보유', ar: 'موجود بالفعل'
            },
            'launch_game': {
                tr: 'Oyunu Başlat', en: 'Launch Game', de: 'Spiel starten', fr: 'Lancer le jeu', es: 'Iniciar juego', ru: 'Запустить игру', zh: '启动游戏', ja: 'ゲーム開始', it: 'Avvia gioco', pt: 'Iniciar jogo', ko: '게임 시작', ar: 'تشغيل اللعبة'
            },
            'delete_game': {
                tr: 'Oyunu Sil', en: 'Delete Game', de: 'Spiel löschen', fr: 'Supprimer le jeu', es: 'Eliminar juego', ru: 'Удалить игру', zh: '删除游戏', ja: 'ゲーム削除', it: 'Elimina gioco', pt: 'Excluir jogo', ko: '게임 삭제', ar: 'حذف اللعبة'
            },
            'view_details': {
                tr: 'Detayları Görüntüle', en: 'View Details', de: 'Details anzeigen', fr: 'Voir les détails', es: 'Ver detalles', ru: 'Подробнее', zh: '查看详情', ja: '詳細を見る', it: 'Vedi dettagli', pt: 'Ver detalhes', ko: '상세 보기', ar: 'عرض التفاصيل'
            },
            'free': {
                tr: 'Ücretsiz', en: 'Free', de: 'Kostenlos', fr: 'Gratuit', es: 'Gratis', ru: 'Бесплатно', zh: '免费', ja: '無料', it: 'Gratis', pt: 'Grátis', ko: '무료', ar: 'مجاني'
            },
            'discount': {
                tr: 'İndirim', en: 'Discount', de: 'Rabatt', fr: 'Remise', es: 'Descuento', ru: 'Скидка', zh: '折扣', ja: '割引', it: 'Sconto', pt: 'Desconto', ko: '할인', ar: 'خصم'
            },
            'game_not_found': {
                tr: 'Oyun bulunamadı', en: 'Game not found', de: 'Spiel nicht gefunden', fr: 'Jeu introuvable', es: 'Juego no encontrado', ru: 'Игра не найдена', zh: '未找到游戏', ja: 'ゲームが見つかりません', it: 'Gioco non trovato', pt: 'Jogo não encontrado', ko: '게임을 찾을 수 없음', ar: 'اللعبة غير موجودة'
            },
            'success': {
                tr: 'Başarılı', en: 'Success', de: 'Erfolg', fr: 'Succès', es: 'Éxito', ru: 'Успешно', zh: '成功', ja: '成功', it: 'Successo', pt: 'Sucesso', ko: '성공', ar: 'نجاح'
            },
            'error': {
                tr: 'Hata', en: 'Error', de: 'Fehler', fr: 'Erreur', es: 'Error', ru: 'Ошибка', zh: '错误', ja: 'エラー', it: 'Errore', pt: 'Erro', ko: '오류', ar: 'خطأ'
            },
            'game_added': {
                tr: 'Oyun kütüphanene eklendi', en: 'Game added to your library', de: 'Spiel zur Bibliothek hinzugefügt', fr: 'Jeu ajouté à votre bibliothèque', es: 'Juego añadido a tu biblioteca', ru: 'Игра добавлена в библиотеку', zh: '已添加到库', ja: 'ライブラリに追加されました', it: 'Gioco aggiunto alla libreria', pt: 'Jogo adicionado à biblioteca', ko: '라이브러리에 추가됨', ar: 'تمت إضافة اللعبة إلى مكتبتك'
            },
            'game_add_failed': {
                tr: 'Oyun kütüphaneye eklenemedi', en: 'Failed to add game', de: 'Spiel konnte nicht hinzugefügt werden', fr: 'Échec de l\'ajout du jeu', es: 'No se pudo añadir el juego', ru: 'Не удалось добавить игру', zh: '无法添加游戏', ja: 'ゲームを追加できませんでした', it: 'Impossibile aggiungere il gioco', pt: 'Falha ao adicionar o jogo', ko: '게임 추가 실패', ar: 'فشل في إضافة اللعبة'
            },
            'load_more': {
                tr: 'Daha fazla oyun yükle', en: 'Load more games', de: 'Mehr Spiele laden', fr: 'Charger plus de jeux', es: 'Cargar más juegos', ru: 'Загрузить больше игр', zh: '加载更多游戏', ja: 'さらにゲームを読み込む', it: 'Carica altri giochi', pt: 'Carregar mais jogos', ko: '더 많은 게임 불러오기', ar: 'تحميل المزيد من الألعاب'
            },
            'searching': {
                tr: 'Aranıyor...', en: 'Searching...', de: 'Wird gesucht...', fr: 'Recherche...', es: 'Buscando...', ru: 'Поиск...', zh: '搜索中...', ja: '検索中...', it: 'Ricerca...', pt: 'Pesquisando...', ko: '검색 중...', ar: 'يتم البحث...'
            },
            'no_results': {
                tr: 'Sonuç bulunamadı', en: 'No results found', de: 'Keine Ergebnisse gefunden', fr: 'Aucun résultat trouvé', es: 'No se encontraron resultados', ru: 'Результаты не найдены', zh: '未找到结果', ja: '結果が見つかりません', it: 'Nessun risultato trovato', pt: 'Nenhum resultado encontrado', ko: '결과 없음', ar: 'لم يتم العثور على نتائج'
            },
            'no_games': {
                tr: 'Hiç oyun bulunamadı', en: 'No games found', de: 'Keine Spiele gefunden', fr: 'Aucun jeu trouvé', es: 'No se encontraron juegos', ru: 'Игры не найдены', zh: '未找到游戏', ja: 'ゲームが見つかりません', it: 'Nessun gioco trovato', pt: 'Nenhum jogo encontrado', ko: '게임 없음', ar: 'لم يتم العثور على ألعاب'
            },
            'no_library_games': {
                tr: 'Kütüphanenizde henüz oyun yok', en: 'No games in your library yet', de: 'Noch keine Spiele in der Bibliothek', fr: 'Aucun jeu dans votre bibliothèque', es: 'Aún no hay juegos en tu biblioteca', ru: 'В вашей библиотеке пока нет игр', zh: '您的库中还没有游戏', ja: 'ライブラリにまだゲームがありません', it: 'Nessun gioco nella tua libreria', pt: 'Ainda não há jogos na sua biblioteca', ko: '아직 라이브러리에 게임이 없습니다', ar: 'لا توجد ألعاب في مكتبتك بعد'
            },
            'no_description': {
                tr: 'Açıklama bulunamadı', en: 'No description found', de: 'Keine Beschreibung gefunden', fr: 'Aucune description trouvée', es: 'No se encontró descripción', ru: 'Описание не найдено', zh: '未找到描述', ja: '説明が見つかりません', it: 'Nessuna descrizione trovata', pt: 'Nenhuma descrição encontrada', ko: '설명 없음', ar: 'لم يتم العثور على وصف'
            },
            'very_positive': {
                tr: 'Çok Olumlu', en: 'Very Positive', de: 'Sehr positiv', fr: 'Très positif', es: 'Muy positivo', ru: 'Очень положительно', zh: '特别好评', ja: '非常に好評', it: 'Molto positivo', pt: 'Muito positivo', ko: '매우 긍정적', ar: 'إيجابي جدًا'
            },
            'mixed': {
                tr: 'Karışık', en: 'Mixed', de: 'Gemischt', fr: 'Mitigé', es: 'Mixto', ru: 'Смешанные', zh: '褒贬不一', ja: '賛否両論', it: 'Misto', pt: 'Misto', ko: '복합적', ar: 'مختلط'
            },
            'home': {
                tr: 'Ana Sayfa', en: 'Home', de: 'Startseite', fr: 'Accueil', es: 'Inicio', ru: 'Главная', zh: '首页', ja: 'ホーム', it: 'Home', pt: 'Início', ko: '홈', ar: 'الرئيسية'
            },
            'library_tab': {
                tr: 'Kütüphane', en: 'Library', de: 'Bibliothek', fr: 'Bibliothèque', es: 'Biblioteca', ru: 'Библиотека', zh: '库', ja: 'ライブラリ', it: 'Libreria', pt: 'Biblioteca', ko: '라이브러리', ar: 'المكتبة'
            },
            'settings_tab': {
                tr: 'Ayarlar', en: 'Settings', de: 'Einstellungen', fr: 'Paramètres', es: 'Configuración', ru: 'Настройки', zh: '设置', ja: '設定', it: 'Impostazioni', pt: 'Configurações', ko: '설정', ar: 'الإعدادات'
            },
            'start_game': {
                tr: 'Oyunu Başlat', en: 'Launch Game', de: 'Spiel starten', fr: 'Lancer le jeu', es: 'Iniciar juego', ru: 'Запустить игру', zh: '启动游戏', ja: 'ゲーム開始', it: 'Avvia gioco', pt: 'Iniciar jogo', ko: '게임 시작', ar: 'تشغيل اللعبة'
            },
            'remove_game': {
                tr: 'Oyunu Sil', en: 'Delete Game', de: 'Spiel löschen', fr: 'Supprimer le jeu', es: 'Eliminar juego', ru: 'Удалить игру', zh: '删除游戏', ja: 'ゲーム削除', it: 'Elimina gioco', pt: 'Excluir jogo', ko: '게임 삭제', ar: 'حذف اللعبة'
            },
            'already_added': {
                tr: 'Zaten Sahipsiniz', en: 'Already Owned', de: 'Bereits vorhanden', fr: 'Déjà possédé', es: 'Ya en tu biblioteca', ru: 'Уже есть', zh: '已拥有', ja: 'すでに所有', it: 'Già posseduto', pt: 'Já possui', ko: '이미 보유', ar: 'موجود بالفعل'
            },
            'featured_game': {
                tr: 'Öne Çıkan Oyun', en: 'Featured Game', de: 'Vorgestelltes Spiel', fr: 'Jeu présenté', es: 'Juego destacado', ru: 'Рекомендуемое игровое программное обеспечение', zh: '推荐游戏', ja: 'おすすめゲーム', it: 'Gioco in evidenza', pt: 'Jogo em destaque', ko: '추천 게임', ar: 'اللعبة الموصى بها'
            },
            'loading': {
                tr: 'Yükleniyor...', en: 'Loading...', de: 'Lädt...', fr: 'Chargement...', es: 'Cargando...', ru: 'Загрузка...', zh: '加载中...', ja: '読み込み中...', it: 'Caricamento...', pt: 'Carregando...', ko: '로딩 중...', ar: 'جاري التحميل...'
            },
            'discovering_games': {
                tr: 'Harika oyunlar keşfediliyor...', en: 'Discovering great games...', de: 'Entdecken Sie großartige Spiele...', fr: 'Découvrez de superbes jeux...', es: 'Descubriendo juegos geniales...', ru: 'Открываем замечательные игры...', zh: '发现精彩游戏...', ja: '素晴らしいゲームを発見中...', it: 'Scopri giochi fantastici...', pt: 'Descobrindo jogos incríveis...', ko: '멋진 게임을 발견 중...', ar: 'جاري اكتشاف الألعاب الرائعة...'
            },
            'price': {
                tr: 'Fiyat', en: 'Price', de: 'Preis', fr: 'Prix', es: 'Precio', ru: 'Цена', zh: '价格', ja: '価格', it: 'Prezzo', pt: 'Preço', ko: '가격', ar: 'السعر'
            },
            'featured_games': {
                tr: 'Öne Çıkan Oyunlar', en: 'Featured Games', de: 'Vorgestellte Spiele', fr: 'Jeux présentés', es: 'Juegos destacados', ru: 'Рекомендуемые игры', zh: '推荐游戏', ja: 'おすすめゲーム', it: 'Giocchi in evidenza', pt: 'Jogos em destaque', ko: '추천 게임', ar: 'الألعاب الموصى بها'
            },
            'steam_page': {
                tr: 'Steam Sayfası', en: 'Steam Page', de: 'Steam Seite', fr: 'Page Steam', es: 'Página de Steam', ru: 'Страница Steam', zh: 'Steam页面', ja: 'Steamページ', it: 'Pagina Steam', pt: 'Página Steam', ko: 'Steam 페이지', ar: 'صفحة Steam'
            },
            'steam_config': {
                tr: 'Steam Yapılandırması', en: 'Steam Configuration', de: 'Steam-Konfiguration', fr: 'Configuration Steam', es: 'Configuración de Steam', ru: 'Настройка Steam', zh: 'Steam设置', ja: 'Steam設定', it: 'Configurazione Steam', pt: 'Configuração Steam', ko: 'Steam 설정', pl: 'Konfiguracja Steam'
            },
            'steam_path': {
                tr: 'Steam Kurulum Yolu:', en: 'Steam Install Path:', de: 'Steam Installationspfad:', fr: 'Chemin d\'installation Steam:', es: 'Ruta de instalación de Steam:', ru: 'Путь установки Steam:', zh: 'Steam安装路径:', ja: 'Steamインストールパス:', it: 'Percorso di installazione Steam:', pt: 'Caminho de instalação do Steam:', ko: 'Steam 설치 경로:', pl: 'Ścieżka instalacji Steam:'
            },
            'steam_path_placeholder': {
                tr: 'Yüklü Steam dizini', en: 'Installed Steam directory', de: 'Installiertes Steam-Verzeichnis', fr: 'Répertoire Steam installé', es: 'Directorio de Steam instalado', ru: 'Установленный каталог Steam', zh: '已安装的Steam目录', ja: 'インストール済みのSteamディレクトリ', it: 'Directory Steam installata', pt: 'Diretório Steam instalado', ko: '설치된 Steam 디렉토리', pl: 'Zainstalowany katalog Steam'
            },
            'browse': {
                tr: 'Gözat', en: 'Browse', de: 'Durchsuchen', fr: 'Parcourir', es: 'Examinar', ru: 'Обзор', zh: '浏览', ja: '参照', it: 'Sfoglia', pt: 'Procurar', ko: '찾아보기', pl: 'Przeglądaj'
            },
            'app_settings': {
                tr: 'Uygulama Ayarları', en: 'App Settings', de: 'App-Einstellungen', fr: 'Paramètres de l\'application', es: 'Configuración de la aplicación', ru: 'Настройки приложения', zh: '应用设置', ja: 'アプリ設定', it: 'Impostazioni app', pt: 'Configurações do aplicativo', ko: '앱 설정', pl: 'Ustawienia aplikacji'
            },
            'enable_discord': {
                tr: 'Discord Rich Presence\'ı Etkinleştir', en: 'Enable Discord Rich Presence', de: 'Discord Rich Presence aktivieren', fr: 'Activer Discord Rich Presence', es: 'Activar Discord Rich Presence', ru: 'Включить Discord Rich Presence', zh: '启用Discord Rich Presence', ja: 'Discord Rich Presenceを有効にする', it: 'Abilita Discord Rich Presence', pt: 'Ativar Discord Rich Presence', ko: 'Discord Rich Presence 활성화', pl: 'Włącz Discord Rich Presence'
            },
            'enable_animations': {
                tr: 'Animasyonları Etkinleştir', en: 'Enable Animations', de: 'Animationen aktivieren', fr: 'Activer les animations', es: 'Activar animaciones', ru: 'Включить анимации', zh: '启用动画', ja: 'アニメーションを有効にする', it: 'Abilita animazioni', pt: 'Ativar animações', ko: '애니메이션 활성화', pl: 'Włącz animacje'
            },
            'enable_sounds': {
                tr: 'Ses Efektlerini Etkinleştir', en: 'Enable Sound Effects', de: 'Soundeffekte aktivieren', fr: 'Activer les effets sonores', es: 'Activar efectos de sonido', ru: 'Включить звуковые эффекты', zh: '启用音效', ja: '効果音を有効にする', it: 'Abilita effetti sonori', pt: 'Ativar efeitos sonoros', ko: '사운드 효과 활성화', pl: 'Włącz efekty dźwiękowe'
            },
            'game_title': {
                tr: 'Oyun Adı', en: 'Game Title', de: 'Spieltitel', fr: 'Titre du jeu', es: 'Título del juego', ru: 'Название игры', zh: '游戏名称', ja: 'ゲームタイトル', it: 'Titolo del gioco', pt: 'Título do jogo', ko: '게임 제목', pl: 'Tytuł gry'
            },
            'developer': {
                tr: 'Geliştirici', en: 'Developer', de: 'Entwickler', fr: 'Développeur', es: 'Desarrollador', ru: 'Разработчик', zh: '开发者', ja: '開発者', it: 'Sviluppatore', pt: 'Desenvolvedor', ko: '개발자', pl: 'Deweloper'
            },
            'release_year': {
                tr: 'Yıl', en: 'Year', de: 'Jahr', fr: 'Année', es: 'Año', ru: 'Год', zh: '年份', ja: '年', it: 'Anno', pt: 'Ano', ko: '연도', pl: 'Rok'
            },
            'rating': {
                tr: 'Değerlendirme', en: 'Rating', de: 'Bewertung', fr: 'Évaluation', es: 'Valoración', ru: 'Оценка', zh: '评分', ja: '評価', it: 'Valutazione', pt: 'Avaliação', ko: '평가', pl: 'Ocena'
            },
            'price': {
                tr: 'Fiyat', en: 'Price', de: 'Preis', fr: 'Prix', es: 'Precio', ru: 'Цена', zh: '价格', ja: '価格', it: 'Prezzo', pt: 'Preço', ko: '가격', pl: 'Cena'
            },
            'reviews': {
                tr: 'İncelemeler', en: 'Reviews', de: 'Rezensionen', fr: 'Avis', es: 'Reseñas', ru: 'Отзывы', zh: '评论', ja: 'レビュー', it: 'Recensioni', pt: 'Avaliações', ko: '리뷰', pl: 'Recenzje'
            },
            'about_game': {
                tr: 'Bu Oyun Hakkında', en: 'About This Game', de: 'Über dieses Spiel', fr: 'À propos de ce jeu', es: 'Acerca de este juego', ru: 'Об этой игре', zh: '关于本游戏', ja: 'このゲームについて', it: 'Informazioni su questo gioco', pt: 'Sobre este jogo', ko: '이 게임에 대하여', pl: 'O tej grze'
            },
            'game_description': {
                tr: 'Oyun açıklaması burada yüklenecek...', en: 'Game description will be loaded here...', de: 'Spielbeschreibung wird hier geladen...', fr: 'La description du jeu sera chargée ici...', es: 'La descripción del juego se cargará aquí...', ru: 'Описание игры будет загружено здесь...', zh: '游戏描述将在此加载...', ja: 'ゲームの説明がここに表示されます...', it: 'La descrizione del gioco verrà caricata qui...', pt: 'A descrição do jogo será carregada aqui...', ko: '게임 설명이 여기에 표시됩니다...', pl: 'Opis gry zostanie tutaj załadowany...'
            },
            'publisher': {
                tr: 'Yayıncı', en: 'Publisher', de: 'Herausgeber', fr: 'Éditeur', es: 'Editor', ru: 'Издатель', zh: '发行商', ja: 'パブリッシャー', it: 'Editore', pt: 'Editora', ko: '퍼블리셔', pl: 'Wydawca'
            },
            'release_date': {
                tr: 'Çıkış Tarihi', en: 'Release Date', de: 'Erscheinungsdatum', fr: 'Date de sortie', es: 'Fecha de lanzamiento', ru: 'Дата выхода', zh: '发布日期', ja: '発売日', it: 'Data di rilascio', pt: 'Data de lançamento', ko: '출시일', pl: 'Data wydania'
            },
            'genres': {
                tr: 'Türler', en: 'Genres', de: 'Genres', fr: 'Genres', es: 'Géneros', ru: 'Жанры', zh: '类型', ja: 'ジャンル', it: 'Generi', pt: 'Gêneros', ko: '장르', pl: 'Gatunki'
            },
            'open_in_steam': {
                tr: "Steam'de Aç", en: 'Open in Steam', de: 'In Steam öffnen', fr: 'Ouvrir dans Steam', es: 'Abrir en Steam', ru: 'Открыть в Steam', zh: '在Steam中打开', ja: 'Steamで開く', it: 'Apri su Steam', pt: 'Abrir no Steam', ko: 'Steam에서 열기', pl: 'Otwórz w Steam'
            },
            'loading_games': {
                tr: 'Yükleniyor...', en: 'Loading...', de: 'Lädt...', fr: 'Chargement...', es: 'Cargando...', ru: 'Загрузка...', zh: '加载中...', ja: '読み込み中...', it: 'Caricamento...', pt: 'Carregando...', ko: '로딩 중...', ar: 'جاري التحميل...'
            },
            'feature_coming_soon': {
                tr: 'Oyunu başlatma özelliği yakında eklenecek.', en: 'Game launch feature coming soon.', de: 'Spielstart-Funktion kommt bald.', fr: 'Fonction de lancement du jeu bientôt disponible.', es: 'La función de inicio de juego llegará pronto.', ru: 'Функция запуска игры скоро появится.', zh: '即将推出游戏启动功能。', ja: 'ゲーム起動機能は近日公開予定です。', it: 'La funzione di avvio del gioco arriverà presto.', pt: 'Recurso de iniciar jogo em breve.', ko: '게임 실행 기능 곧 제공 예정.', pl: 'Funkcja uruchamiania gry już wkrótce.' },
            'error': { tr: 'Hata', en: 'Error', de: 'Fehler', fr: 'Erreur', es: 'Error', ru: 'Ошибка', zh: '错误', ja: 'エラー', it: 'Errore', pt: 'Erro', ko: '오류', pl: 'Błąd' },
            'success': { tr: 'Başarılı', en: 'Success', de: 'Erfolg', fr: 'Succès', es: 'Éxito', ru: 'Успешно', zh: '成功', ja: '成功', it: 'Successo', pt: 'Sucesso', ko: '성공', pl: 'Sukces' },
            'info': { tr: 'Bilgi', en: 'Info', de: 'Info', fr: 'Info', es: 'Información', ru: 'Инфо', zh: '信息', ja: '情報', it: 'Info', pt: 'Informação', ko: '정보', pl: 'Informacja' },
            'game_not_found': { tr: 'Oyun bulunamadı', en: 'Game not found', de: 'Spiel nicht gefunden', fr: 'Jeu introuvable', es: 'Juego no encontrado', ru: 'Игра не найдена', zh: '未找到游戏', ja: 'ゲームが見つかりません', it: 'Gioco non trovato', pt: 'Jogo não encontrado', ko: '게임을 찾을 수 없음', pl: 'Nie znaleziono gry' },
            'game_deleted': { tr: 'Oyun kütüphaneden silindi.', en: 'Game deleted from library.', de: 'Spiel aus Bibliothek gelöscht.', fr: 'Jeu supprimé de la bibliothèque.', es: 'Juego eliminado de la biblioteca.', ru: 'Игра удалена из библиотеки.', zh: '游戏已从库中删除。', ja: 'ライブラリからゲームが削除されました。', it: 'Gioco eliminato dalla libreria.', pt: 'Jogo removido da biblioteca.', ko: '라이브러리에서 게임이 삭제되었습니다.', pl: 'Gra została usunięta z biblioteki.' },
            'game_delete_failed': { tr: 'Oyun silinemedi.', en: 'Game could not be deleted.', de: 'Spiel konnte nicht gelöscht werden.', fr: 'Impossible de supprimer le jeu.', es: 'No se pudo eliminar el juego.', ru: 'Не удалось удалить игру.', zh: '无法删除游戏。', ja: 'ゲームを削除できませんでした。', it: 'Impossibile eliminare il gioco.', pt: 'Não foi possível remover o jogo.', ko: '게임을 삭제할 수 없습니다.', pl: 'Nie można usunąć gry.' },
            'feature_coming_soon': { tr: 'Oyunu başlatma özelliği yakında eklenecek.', en: 'Game launch feature coming soon.', de: 'Spielstart-Funktion kommt bald.', fr: 'Fonction de lancement du jeu bientôt disponible.', es: 'La función de inicio de juego llegará pronto.', ru: 'Функция запуска игры скоро появится.', zh: '即将推出游戏启动功能。', ja: 'ゲーム起動機能は近日公開予定です。', it: 'La funzione di avvio del gioco arriverà presto.', pt: 'Recurso de iniciar jogo em breve.', ko: '게임 실행 기능 곧 제공 예정.', pl: 'Funkcja uruchamiania gry już wkrótce.' },
            'settings_saved': { tr: 'Ayarlar kaydedildi', en: 'Settings saved', de: 'Einstellungen gespeichert', fr: 'Paramètres enregistrés', es: 'Configuración guardada', ru: 'Настройки сохранены', zh: '设置已保存', ja: '設定が保存されました', it: 'Impostazioni salvate', pt: 'Configurações salvas', ko: '설정이 저장되었습니다', pl: 'Ustawienia zapisane' },
            'settings_save_failed': { tr: 'Ayarlar kaydedilemedi', en: 'Settings could not be saved', de: 'Einstellungen konnten nicht gespeichert werden', fr: 'Impossible d\'enregistrer les paramètres', es: 'No se pudo guardar la configuración', ru: 'Не удалось сохранить настройки', zh: '无法保存设置', ja: '設定を保存できませんでした', it: 'Impossibile salvare le impostazioni', pt: 'Não foi possível salvar as configurações', ko: '설정을 저장할 수 없습니다', pl: 'Nie można zapisać ustawień' },
            'config_load_failed': { tr: 'Yapılandırma yüklenemedi', en: 'Configuration could not be loaded', de: 'Konfiguration konnte nicht geladen werden', fr: 'Impossible de charger la configuration', es: 'No se pudo cargar la configuración', ru: 'Не удалось загрузить конфигурацию', zh: '无法加载配置', ja: '構成を読み込めませんでした', it: 'Impossibile caricare la configurazione', pt: 'Não foi possível carregar a configuração', ko: '구성을 불러올 수 없습니다', pl: 'Nie można załadować konfiguracji' },
            'steam_path_set': { tr: 'Steam yolu başarıyla yapılandırıldı', en: 'Steam path set successfully', de: 'Steam-Pfad erfolgreich festgelegt', fr: 'Chemin Steam défini avec succès', es: 'Ruta de Steam configurada correctamente', ru: 'Путь к Steam успешно установлен', zh: 'Steam路径设置成功', ja: 'Steamパスが正常に設定されました', it: 'Percorso Steam impostato con successo', pt: 'Caminho do Steam definido com sucesso', ko: 'Steam 경로가 성공적으로 설정되었습니다', pl: 'Ścieżka Steam została pomyślnie ustawiona' },
            'steam_path_failed': { tr: 'Steam yolu seçilemedi', en: 'Failed to set Steam path', de: 'Steam-Pfad konnte nicht festgelegt werden', fr: 'Impossible de définir le chemin Steam', es: 'No se pudo establecer la ruta de Steam', ru: 'Не удалось установить путь к Steam', zh: '无法设置Steam路径', ja: 'Steamパスを設定できませんでした', it: 'Impossibile impostare il percorso Steam', pt: 'Não foi possível definir o caminho do Steam', ko: 'Steam 경로를 설정할 수 없습니다', pl: 'Nie można ustawić ścieżki Steam' },
            'restart_steam_title': { tr: "Steam'i Yeniden Başlat", en: 'Restart Steam', de: 'Steam neu starten', fr: 'Redémarrer Steam', es: 'Reiniciar Steam', ru: 'Перезапустить Steam', zh: '重新启动Steam', ja: 'Steamを再起動', it: 'Riavvia Steam', pt: 'Reiniciar Steam', ko: 'Steam 재시작', pl: 'Uruchom ponownie Steam' },
            'restart_steam_info': { tr: "Oyun kütüphanenize eklendi! Değişiklikleri görmek için Steam'in yeniden başlatılması gerekiyor.", en: 'Game added to your library! To see the changes, Steam needs to be restarted.', de: 'Spiel zur Bibliothek hinzugefügt! Um die Änderungen zu sehen, muss Steam neu gestartet werden.', fr: 'Jeu ajouté à votre bibliothèque ! Pour voir les modifications, Steam doit être redémarré.', es: '¡Juego añadido a tu biblioteca! Para ver los cambios, es necesario reiniciar Steam.', ru: 'Игра добавлена в вашу библиотеку! Чтобы увидеть изменения, необходимо перезапустить Steam.', zh: '游戏已添加到您的库中！要查看更改，需要重新启动Steam。', ja: 'ゲームがライブラリに追加されました！変更を反映するにはSteamを再起動してください。', it: 'Gioco aggiunto alla tua libreria! Per vedere le modifiche, è necessario riavviare Steam.', pt: 'Jogo adicionado à sua biblioteca! Para ver as alterações, é necessário reiniciar o Steam.', ko: '게임이 라이브러리에 추가되었습니다! 변경 사항을 보려면 Steam을 재시작해야 합니다.', pl: 'Gra została dodana do twojej biblioteki! Aby zobaczyć zmiany, musisz ponownie uruchomić Steam.' },
            'restart_steam_question': { tr: "Steam'i şimdi yeniden başlatmak istiyor musunuz?", en: 'Do you want to restart Steam now?', de: 'Möchten Sie Steam jetzt neu starten?', fr: 'Voulez-vous redémarrer Steam maintenant ?', es: '¿Quieres reiniciar Steam ahora?', ru: 'Вы хотите перезапустить Steam сейчас?', zh: '现在要重新启动Steam吗？', ja: '今すぐSteamを再起動しますか？', it: 'Vuoi riavviare Steam ora?', pt: 'Deseja reiniciar o Steam agora?', ko: '지금 Steam을 재시작하시겠습니까?', pl: 'Czy chcesz teraz ponownie uruchomić Steam?' },
            'restart_steam_yes': { tr: 'Evet, Yeniden Başlat', en: 'Yes, Restart', de: 'Ja, neu starten', fr: 'Oui, redémarrer', es: 'Sí, reiniciar', ru: 'Да, перезапустить', zh: '是的，重新启动', ja: 'はい、再起動します', it: 'Sì, riavvia', pt: 'Sim, reiniciar', ko: '예, 재시작', pl: 'Tak, uruchom ponownie' },
            'restart_steam_no': { tr: 'Hayır, Daha Sonra', en: 'No, Later', de: 'Nein, später', fr: 'Non, plus tard', es: 'No, más tarde', ru: 'Нет, позже', zh: '不，稍后', ja: 'いいえ、後で', it: 'No, più tardi', pt: 'Não, mais tarde', ko: '아니요, 나중에', pl: 'Nie, później' },
            'select_dlcs': { tr: "DLC'leri Seç", en: 'Select DLCs', de: 'DLCs auswählen', fr: 'Sélectionner les DLC', es: 'Seleccionar DLCs', ru: 'Выбрать DLC', zh: '选择DLC', ja: 'DLCを選択', it: 'Seleziona DLC', pt: 'Selecionar DLCs', ko: 'DLC 선택', pl: 'Wybierz DLC' },
            'add_selected': { tr: 'Seçilenleri Ekle', en: 'Add Selected', de: 'Ausgewählte hinzufügen', fr: 'Ajouter la sélection', es: 'Agregar seleccionados', ru: 'Добавить выбранные', zh: '添加所选', ja: '選択したものを追加', it: 'Aggiungi selezionati', pt: 'Adicionar selecionados', ko: '선택 항목 추가', pl: 'Dodaj wybrane' },
            'cancel': { tr: 'İptal', en: 'Cancel', de: 'Abbrechen', fr: 'Annuler', es: 'Cancelar', ru: 'Отмена', zh: '取消', ja: 'キャンセル', it: 'Annulla', pt: 'Cancelar', ko: '취소', pl: 'Anuluj' },
            'select_all_dlcs': {
                tr: "Tüm DLC'leri Seç", en: 'Select All DLCs', de: 'Alle DLCs auswählen', fr: 'Tout sélectionner', es: 'Seleccionar todos los DLC', ru: 'Выбрать все DLC', zh: '全选DLC', ja: 'すべてのDLCを選択', it: 'Seleziona tutti i DLC', pt: 'Selecionar todos os DLCs', ko: '모든 DLC 선택', pl: 'Zaznacz wszystkie DLC'
            },
            'dlc_free': {
                tr: 'Ücretsiz', en: 'Free', de: 'Kostenlos', fr: 'Gratuit', es: 'Gratis', ru: 'Бесплатно', zh: '免费', ja: '無料', it: 'Gratis', pt: 'Grátis', ko: '무료', pl: 'Darmowe'
            },
            'dlc_price': {
                tr: 'Fiyat', en: 'Price', de: 'Preis', fr: 'Prix', es: 'Precio', ru: 'Цена', zh: '价格', ja: '価格', it: 'Prezzo', pt: 'Preço', ko: '가격', pl: 'Cena'
            },
            'dlc_release_date': {
                tr: 'Çıkış Tarihi', en: 'Release Date', de: 'Erscheinungsdatum', fr: 'Date de sortie', es: 'Fecha de lanzamiento', ru: 'Дата выхода', zh: '发布日期', ja: '発売日', it: 'Data di rilascio', pt: 'Data de lançamento', ko: '출시일', pl: 'Data wydania'
            },
            'game_added_with_dlcs': {
                tr: 'Oyun {dlcCount} DLC ile eklendi',
                en: 'Game added with {dlcCount} DLC(s)',
                de: 'Spiel mit {dlcCount} DLC(s) hinzugefügt',
                fr: 'Jeu ajouté avec {dlcCount} DLC',
                es: 'Juego añadido con {dlcCount} DLC(s)',
                ru: 'Игра добавлена с {dlcCount} DLC',
                zh: '已添加带有{dlcCount}个DLC的游戏',
                ja: '{dlcCount}個のDLC付きでゲームが追加されました',
                it: 'Gioco aggiunto con {dlcCount} DLC',
                pt: 'Jogo adicionado com {dlcCount} DLC(s)',
                ko: '{dlcCount}개의 DLC와 함께 게임이 추가되었습니다',
                pl: 'Gra dodana z {dlcCount} DLC'
            },
            'game_add_with_dlcs_failed': {
                tr: 'Oyun DLC\'lerle eklenemedi',
                en: 'Failed to add game with DLCs',
                de: 'Spiel konnte mit DLCs nicht hinzugefügt werden',
                fr: 'Échec de l\'ajout du jeu avec les DLC',
                es: 'No se pudo añadir el juego con los DLC',
                ru: 'Не удалось добавить игру с DLC',
                zh: '无法添加带有DLC的游戏',
                ja: 'DLC付きのゲームを追加できませんでした',
                it: 'Impossibile aggiungere il gioco con i DLC',
                pt: 'Falha ao adicionar o jogo com DLCs',
                ko: 'DLC와 함께 게임을 추가하지 못했습니다',
                pl: 'Nie można dodać gry z DLC'
            },
            'mute_videos': {
                tr: 'Oyun detaylarındaki videoların sesi otomatik kapalı olsun',
                en: 'Mute videos in game details by default',
                de: 'Videos in Spieledetails standardmäßig stummschalten',
                fr: 'Couper le son des vidéos dans les détails du jeu par défaut',
                es: 'Silenciar videos en los detalles del juego por defecto',
                ru: 'Отключить звук видео в деталях игры по умолчанию',
                zh: '默认静音游戏详情中的视频',
                ja: 'ゲーム詳細の動画をデフォルトでミュート',
                it: 'Disattiva l\'audio dei video nei dettagli gioco',
                pt: 'Silenciar vídeos nos detalhes do jogo por padrão',
                ko: '게임 상세 정보의 비디오를 기본적으로 음소거',
                pl: 'Domyślnie wyciszaj filmy w szczegółach gry'
            },
            'refresh_library': {
                tr: 'Kütüphaneyi Yenile',
                en: 'Refresh Library',
                de: 'Bibliothek aktualisieren',
                fr: 'Actualiser la bibliothèque',
                es: 'Actualizar biblioteca',
                ru: 'Обновить библиотеку',
                zh: '刷新库',
                ja: 'ライブラリを更新',
                it: 'Aggiorna libreria',
                pt: 'Atualizar biblioteca',
                ko: '라이브러리 새로고침',
                pl: 'Odśwież bibliotekę'
            },
            'refreshing_library': {
                tr: 'Kütüphane yenileniyor...',
                en: 'Refreshing library...',
                de: 'Bibliothek wird aktualisiert...',
                fr: 'Actualisation de la bibliothèque...',
                es: 'Actualizando biblioteca...',
                ru: 'Обновление библиотеки...',
                zh: '正在刷新库...',
                ja: 'ライブラリを更新中...',
                it: 'Aggiornamento libreria...',
                pt: 'Atualizando biblioteca...',
                ko: '라이브러리 새로고침 중...',
                pl: 'Odświeżanie biblioteki...'
            },
            'library_refreshed': {
                tr: 'Kütüphane başarıyla yenilendi',
                en: 'Library refreshed successfully',
                de: 'Bibliothek erfolgreich aktualisiert',
                fr: 'Bibliothèque actualisée avec succès',
                es: 'Biblioteca actualizada correctamente',
                ru: 'Библиотека успешно обновлена',
                zh: '库刷新成功',
                ja: 'ライブラリが正常に更新されました',
                it: 'Libreria aggiornata con successo',
                pt: 'Biblioteca atualizada com sucesso',
                ko: '라이브러리가 성공적으로 새로고침되었습니다',
                pl: 'Biblioteka została pomyślnie odświeżona'
            },
            'library_refresh_failed': {
                tr: 'Kütüphane yenilenemedi',
                en: 'Failed to refresh library',
                de: 'Bibliothek konnte nicht aktualisiert werden',
                fr: 'Échec de l\'actualisation de la bibliothèque',
                es: 'Error al actualizar biblioteca',
                ru: 'Не удалось обновить библиотеку',
                zh: '刷新库失败',
                ja: 'ライブラリの更新に失敗しました',
                it: 'Impossibile aggiornare la libreria',
                pt: 'Falha ao atualizar biblioteca',
                ko: '라이브러리 새로고침 실패',
                pl: 'Nie udało się odświeżyć biblioteki'
            },
            'manual_install': {
                tr: 'Manuel Kurulum',
                en: 'Manual Install',
                de: 'Manuelle Installation',
                fr: 'Installation manuelle',
                es: 'Instalación manual',
                ru: 'Ручная установка',
                zh: '手动安装',
                ja: '手動インストール',
                it: 'Installazione manuale',
                pt: 'Instalação manual',
                ko: '수동 설치',
                pl: 'Instalacja ręczna'
            },
            'upload_game_file': {
                tr: 'Oyun Dosyasını Yükle',
                en: 'Upload Game File',
                de: 'Spieldatei hochladen',
                fr: 'Télécharger le fichier de jeu',
                es: 'Subir archivo de juego',
                ru: 'Загрузить файл игры',
                zh: '上传游戏文件',
                ja: 'ゲームファイルをアップロード',
                it: 'Carica file di gioco',
                pt: 'Enviar arquivo do jogo',
                ko: '게임 파일 업로드',
                pl: 'Prześlij plik gry'
            },
            'drag_drop_zip': {
                tr: 'ZIP dosyasını buraya sürükleyip bırakın veya tıklayarak seçin',
                en: 'Drag and drop ZIP file here or click to select',
                de: 'ZIP-Datei hierher ziehen oder klicken zum Auswählen',
                fr: 'Glissez-déposez le fichier ZIP ici ou cliquez pour sélectionner',
                es: 'Arrastra y suelta el archivo ZIP aquí o haz clic para seleccionar',
                ru: 'Перетащите ZIP файл сюда или нажмите для выбора',
                zh: '拖放ZIP文件到此处或点击选择',
                ja: 'ZIPファイルをここにドラッグ＆ドロップするか、クリックして選択',
                it: 'Trascina e rilascia il file ZIP qui o clicca per selezionare',
                pt: 'Arraste e solte o arquivo ZIP aqui ou clique para selecionar',
                ko: 'ZIP 파일을 여기에 끌어다 놓거나 클릭하여 선택',
                pl: 'Przeciągnij i upuść plik ZIP tutaj lub kliknij, aby wybrać'
            },
            'select_file': {
                tr: 'Dosya Seç',
                en: 'Select File',
                de: 'Datei auswählen',
                fr: 'Sélectionner le fichier',
                es: 'Seleccionar archivo',
                ru: 'Выбрать файл',
                zh: '选择文件',
                ja: 'ファイルを選択',
                it: 'Seleziona file',
                pt: 'Selecionar arquivo',
                ko: '파일 선택',
                pl: 'Wybierz plik'
            },
            'game_info': {
                tr: 'Oyun Bilgileri',
                en: 'Game Information',
                de: 'Spielinformationen',
                fr: 'Informations sur le jeu',
                es: 'Información del juego',
                ru: 'Информация об игре',
                zh: '游戏信息',
                ja: 'ゲーム情報',
                it: 'Informazioni sul gioco',
                pt: 'Informações do jogo',
                ko: '게임 정보',
                pl: 'Informacje o grze'
            },
            'game_name': {
                tr: 'Oyun Adı',
                en: 'Game Name',
                de: 'Spielname',
                fr: 'Nom du jeu',
                es: 'Nombre del juego',
                ru: 'Название игры',
                zh: '游戏名称',
                ja: 'ゲーム名',
                it: 'Nome del gioco',
                pt: 'Nome do jogo',
                ko: '게임 이름',
                pl: 'Nazwa gry'
            },
            'steam_app_id': {
                tr: 'Steam App ID ',
                en: 'Steam App ID ',
                de: 'Steam App ID ',
                fr: 'ID de l\'application Steam ',
                es: 'ID de la aplicación Steam ',
                ru: 'ID приложения Steam ',
                zh: 'Steam应用ID',
                ja: 'SteamアプリID',
                it: 'ID app Steam ',
                pt: 'ID do aplicativo Steam',
                ko: 'Steam 앱 ID ',
                pl: 'ID aplikacji Steam '
            },
            'game_folder': {
                tr: 'Oyun Klasörü',
                en: 'Game Folder',
                de: 'Spielordner',
                fr: 'Dossier du jeu',
                es: 'Carpeta del juego',
                ru: 'Папка игры',
                zh: '游戏文件夹',
                ja: 'ゲームフォルダ',
                it: 'Cartella del gioco',
                pt: 'Pasta do jogo',
                ko: '게임 폴더',
                pl: 'Folder gry'
            },
            'install_game': {
                tr: 'Oyunu Kur',
                en: 'Install Game',
                de: 'Spiel installieren',
                fr: 'Installer le jeu',
                es: 'Instalar juego',
                ru: 'Установить игру',
                zh: '安装游戏',
                ja: 'ゲームをインストール',
                it: 'Installa gioco',
                pt: 'Instalar jogo',
                ko: '게임 설치',
                pl: 'Zainstaluj grę'
            },
            'only_zip_supported': {
                tr: 'Sadece ZIP dosyaları desteklenir',
                en: 'Only ZIP files are supported',
                de: 'Nur ZIP-Dateien werden unterstützt',
                fr: 'Seuls les fichiers ZIP sont pris en charge',
                es: 'Solo se admiten archivos ZIP',
                ru: 'Поддерживаются только ZIP файлы',
                zh: '仅支持ZIP文件',
                ja: 'ZIPファイルのみサポートされています',
                it: 'Sono supportati solo file ZIP',
                pt: 'Apenas arquivos ZIP são suportados',
                ko: 'ZIP 파일만 지원됩니다',
                pl: 'Obsługiwane są tylko pliki ZIP'
            },
            'file_not_found': {
                tr: 'Seçilen dosya bulunamadı',
                en: 'Selected file not found',
                de: 'Ausgewählte Datei nicht gefunden',
                fr: 'Fichier sélectionné introuvable',
                es: 'Archivo seleccionado no encontrado',
                ru: 'Выбранный файл не найден',
                zh: '未找到所选文件',
                ja: '選択されたファイルが見つかりません',
                it: 'File selezionato non trovato',
                pt: 'Arquivo selecionado não encontrado',
                ko: '선택한 파일을 찾을 수 없습니다',
                pl: 'Nie znaleziono wybranego pliku'
            },
            'invalid_zip': {
                tr: 'Geçersiz ZIP dosyası',
                en: 'Invalid ZIP file',
                de: 'Ungültige ZIP-Datei',
                fr: 'Fichier ZIP invalide',
                es: 'Archivo ZIP inválido',
                ru: 'Неверный ZIP файл',
                zh: '无效的ZIP文件',
                ja: '無効なZIPファイル',
                it: 'File ZIP non valido',
                pt: 'Arquivo ZIP inválido',
                ko: '잘못된 ZIP 파일',
                pl: 'Nieprawidłowy plik ZIP'
            },
            'game_installed_successfully': {
                tr: 'Oyun başarıyla kuruldu',
                en: 'Game installed successfully',
                de: 'Spiel erfolgreich installiert',
                fr: 'Jeu installé avec succès',
                es: 'Juego instalado correctamente',
                ru: 'Игра успешно установлена',
                zh: '游戏安装成功',
                ja: 'ゲームが正常にインストールされました',
                it: 'Gioco installato con successo',
                pt: 'Jogo instalado com sucesso',
                ko: '게임이 성공적으로 설치되었습니다',
                pl: 'Gra została pomyślnie zainstalowana'
            },
            'installation_failed': {
                tr: 'Kurulum başarısız',
                en: 'Installation failed',
                de: 'Installation fehlgeschlagen',
                fr: 'Échec de l\'installation',
                es: 'Error en la instalación',
                ru: 'Ошибка установки',
                zh: '安装失败',
                ja: 'インストールに失敗しました',
                it: 'Installazione fallita',
                pt: 'Falha na instalação',
                ko: '설치 실패',
                pl: 'Instalacja nie powiodła się'
            },
            'please_select_file': {
                tr: 'Lütfen önce bir dosya seçin',
                en: 'Please select a file first',
                de: 'Bitte wählen Sie zuerst eine Datei aus',
                fr: 'Veuillez d\'abord sélectionner un fichier',
                es: 'Por favor, selecciona un archivo primero',
                ru: 'Пожалуйста, сначала выберите файл',
                zh: '请先选择文件',
                ja: '最初にファイルを選択してください',
                it: 'Seleziona prima un file',
                pt: 'Por favor, selecione um arquivo primeiro',
                ko: '먼저 파일을 선택하세요',
                pl: 'Najpierw wybierz plik'
            },

            'installation_error': {
                tr: 'Kurulum sırasında hata oluştu',
                en: 'Error occurred during installation',
                de: 'Fehler bei der Installation aufgetreten',
                fr: 'Erreur survenue lors de l\'installation',
                es: 'Error durante la instalación',
                ru: 'Произошла ошибка во время установки',
                zh: '安装过程中发生错误',
                ja: 'インストール中にエラーが発生しました',
                it: 'Errore durante l\'installazione',
                pt: 'Erro durante a instalação',
                ko: '설치 중 오류가 발생했습니다',
                pl: 'Wystąpił błąd podczas instalacji'
            },
            'selected_file': {
                tr: 'Seçilen Dosya',
                en: 'Selected File',
                de: 'Ausgewählte Datei',
                fr: 'Fichier sélectionné',
                es: 'Archivo seleccionado',
                ru: 'Выбранный файл',
                zh: '已选择的文件',
                ja: '選択されたファイル',
                it: 'File selezionato',
                pt: 'Arquivo selecionado',
                ko: '선택된 파일',
                pl: 'Wybrany plik'
            },
            'file_name': {
                tr: 'Dosya Adı',
                en: 'File Name',
                de: 'Dateiname',
                fr: 'Nom du fichier',
                es: 'Nombre del archivo',
                ru: 'Имя файла',
                zh: '文件名',
                ja: 'ファイル名',
                it: 'Nome file',
                pt: 'Nome do arquivo',
                ko: '파일 이름',
                pl: 'Nazwa pliku'
            },
            'size': {
                tr: 'Boyut',
                en: 'Size',
                de: 'Größe',
                fr: 'Taille',
                es: 'Tamaño',
                ru: 'Размер',
                zh: '大小',
                ja: 'サイズ',
                it: 'Dimensione',
                pt: 'Tamanho',
                ko: '크기',
                pl: 'Rozmiar'
            },
            'select_another_file': {
                tr: 'Başka Dosya Seç',
                en: 'Select Another File',
                de: 'Andere Datei auswählen',
                fr: 'Sélectionner un autre fichier',
                es: 'Seleccionar otro archivo',
                ru: 'Выбрать другой файл',
                zh: '选择其他文件',
                ja: '別のファイルを選択',
                it: 'Seleziona altro file',
                pt: 'Selecionar outro arquivo',
                ko: '다른 파일 선택',
                pl: 'Wybierz inny plik'
            }
        };
        return dict[key] && dict[key][lang] ? dict[key][lang] : dict[key]?.tr || key;
    }

    renderSettingsPage() {
        const settingsContainer = document.getElementById('settings-page');
        if (!settingsContainer) return;
        settingsContainer.innerHTML = `
            <div class="settings-title">${this.translate('settings')}</div>
            <div class="language-select-label">${this.translate('language')}</div>
            <div class="language-select-list">
                ${Object.keys(languageFlagUrls).map(lang => `
                    <button class="lang-btn${this.getSelectedLang()===lang?' selected':''}" onclick="ui.setCurrentLanguage('${lang}')">
                        <img class="flag" src="${languageFlagUrls[lang]}" alt="${lang} flag" width="28" height="20" style="border-radius:4px;box-shadow:0 1px 4px #0002;vertical-align:middle;" />
                        <span class="lang-name">${this.translate('lang_' + lang)}</span>
                    </button>
                `).join('')}
            </div>
            <div class="settings-section">
                <div class="settings-subtitle">${this.translate('app_settings')}</div>
                <label class="setting-item">
                    <input type="checkbox" id="discordRPCToggle" ${this.config.discordRPC ? 'checked' : ''}>
                    <span data-i18n="enable_discord">${this.translate('enable_discord')}</span>
                </label>
                <label class="setting-item">
                    <input type="checkbox" id="videoMutedToggle" ${this.config.videoMuted ? 'checked' : ''}>
                    <span data-i18n="mute_videos">${this.translate('mute_videos')}</span>
                </label>
            </div>
        `;
        // Toggle eventleri
        document.getElementById('discordRPCToggle').addEventListener('change', (e) => {
            this.updateConfig({ discordRPC: e.target.checked });
        });
        document.getElementById('videoMutedToggle').addEventListener('change', (e) => {
            this.updateConfig({ videoMuted: e.target.checked });
        });
    }

    setCurrentLanguage(lang) {
        localStorage.setItem('selectedLang', lang);
        this.renderSettingsPage();
        this.updateTranslations();
    }

    // DLC seçiminden sonra seçilen DLC'lerle oyunu ekle
    confirmGameWithDLCs(appId, selectedDLCs) {
        // addGameToLibrary fonksiyonunu DLC parametresiyle çağır
        this.addGameToLibraryWithDLCs(appId, selectedDLCs);
    }

    // DLC'li oyun ekleme fonksiyonu
    async addGameToLibraryWithDLCs(appId, selectedDLCs) {
        if (!this.config.steamPath) {
            this.showNotification('error', 'steam_path_failed', 'error');
            return;
        }
        // Oyun dosyası API kontrolü (404 ise oyun yok)
        try {
            const res = await fetch(`https://muhammetdag.com/api/v1/game.php?steamid=${appId}`);
            if (res.status === 404) {
                this.showNotification('error', 'game_not_found', 'error');
                return;
            }
        } catch {
            this.showNotification('error', 'game_not_found', 'error');
            return;
        }
        this.showLoading();
        try {
            const result = await ipcRenderer.invoke('add-game-to-library', appId, selectedDLCs);
            if (result.success) {
                this.showNotification('success', 'game_added', 'success');
                this.closeModal('dlcModal');
                this.showSteamRestartDialog();
            }
        } catch (error) {
            console.error('Failed to add game:', error);
            this.showNotification('error', 'game_add_failed', 'error');
        } finally {
            this.hideLoading();
        }
    }

    async loadOnlinePassGames() {
        const cc = this.countryCode || 'TR';
        const lang = this.getSelectedLang();
        const onlineGrid = document.getElementById('onlinePassPage');
        if (!onlineGrid) return;
        onlineGrid.innerHTML = `<div class='page-header' style='width:100%;display:flex;justify-content:center;align-items:center;margin-bottom:24px;'><h1 style='font-size:2.2rem;font-weight:800;color:#00bfff;display:inline-block;'>Online Pass</h1></div><div style="color:#fff;padding:16px;">Yükleniyor...</div>`;
        try {
            const res = await fetch('https://muhammetdag.com/api/v1/onlineliste.php');
            const data = await res.json();
            if (!data.files || !Array.isArray(data.files)) throw new Error('Online oyun listesi alınamadı');
            this.onlinePassGames = data.files;
            this.onlinePassFilteredGames = data.files;
            this.onlinePassCurrentPage = 0;
            this.renderOnlinePassGames();
        } catch (err) {
            onlineGrid.innerHTML = `<div style='color:#fff;padding:16px;'>Online oyunlar yüklenemedi: ${err.message}</div>`;
        }
    }



    async renderOnlinePassGames(list) {
        const onlineGrid = document.getElementById('onlinePassPage');
        if (!onlineGrid) return;
        
        // Sayfa başlığını oluştur
        onlineGrid.innerHTML = `<div class='page-header' style='width:100%;display:flex;justify-content:center;align-items:center;margin-bottom:24px;'><h1 style='font-size:2.2rem;font-weight:800;color:#00bfff;display:inline-block;'>Online Pass</h1></div>`;
        
        // Filtrelenmiş oyunları kullan (list parametresi artık kullanılmıyor)
        const games = this.onlinePassFilteredGames;
        if (!games || games.length === 0) {
            onlineGrid.innerHTML += `<div style='color:#fff;padding:16px;'>Hiç online oyun bulunamadı.</div>`;
            return;
        }
        
        // Sayfalama hesaplamaları
        const startIndex = this.onlinePassCurrentPage * this.onlinePassGamesPerPage;
        const endIndex = startIndex + this.onlinePassGamesPerPage;
        const currentPageGames = games.slice(startIndex, endIndex);
        const totalPages = Math.ceil(games.length / this.onlinePassGamesPerPage);
        
        // Oyun grid'ini oluştur
        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(auto-fit, 300px)';
        grid.style.justifyContent = 'center';
        grid.style.gap = '24px';
        grid.style.padding = '24px 0 0 0';
        grid.style.maxWidth = '100%';
        grid.style.margin = '0';
        
        // Oyun kartlarını asenkron olarak oluştur
        const createGameCard = async (gameId) => {
            const card = document.createElement('div');
            card.className = 'game-card';
            card.style.background = '#181c22';
            card.style.borderRadius = '14px';
            card.style.cursor = 'pointer';
            card.style.boxShadow = '0 2px 12px #0002';
            
            try {
                // Steam API'den oyun bilgilerini çek
                const steamResponse = await fetch(`https://store.steampowered.com/api/appdetails?appids=${gameId}&l=turkish`);
                const steamData = await steamResponse.json();
                
                let gameName = `Oyun ID: ${gameId}`;
                let imageUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${gameId}/header.jpg`;
                
                if (steamData[gameId] && steamData[gameId].success && steamData[gameId].data) {
                    const gameData = steamData[gameId].data;
                    gameName = gameData.name || gameName;
                    imageUrl = gameData.header_image || imageUrl;
                }
                
                const steamUrl = `https://store.steampowered.com/app/${gameId}`;
                
                card.innerHTML = `
                    <img src="${imageUrl}" alt="${gameName}" class="game-image" loading="lazy" style="width:100%;height:160px;object-fit:cover;border-radius:12px 12px 0 0;" onerror="this.src='https://via.placeholder.com/616x353/2a2a2a/666666?text=Görsel+Yok'">
                    <div class="game-info" style="padding:12px;">
                        <h3 class="game-title" style="font-size:18px;font-weight:700;margin-bottom:4px;">${gameName}</h3>
                        <div class="game-meta" style="margin-bottom:6px;">
                            <span style="color:#00bfff;font-size:12px;">Online Pass</span>
                        </div>
                        <button class="game-btn primary" style="width:100%;margin-top:8px;" data-online-add data-appid="${gameId}">Online Ekle</button>
                        <button class="game-btn secondary" style="width:100%;margin-top:8px;background:#222;color:#00bfff;border:1px solid #00bfff;" onclick="event.stopPropagation(); window.open('${steamUrl}','_blank')">Steam Sayfası</button>
                    </div>
                `;
            } catch (error) {
                // Hata durumunda basit kart göster
                const steamUrl = `https://store.steampowered.com/app/${gameId}`;
                const imageUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${gameId}/header.jpg`;
                
                card.innerHTML = `
                    <img src="${imageUrl}" alt="Game ${gameId}" class="game-image" loading="lazy" style="width:100%;height:160px;object-fit:cover;border-radius:12px 12px 0 0;" onerror="this.src='https://via.placeholder.com/616x353/2a2a2a/666666?text=Görsel+Yok'">
                    <div class="game-info" style="padding:12px;">
                        <h3 class="game-title" style="font-size:18px;font-weight:700;margin-bottom:4px;">Oyun ID: ${gameId}</h3>
                        <div class="game-meta" style="margin-bottom:6px;">
                            <span style="color:#00bfff;font-size:12px;">Online Pass</span>
                        </div>
                        <button class="game-btn primary" style="width:100%;margin-top:8px;" data-online-add data-appid="${gameId}">Online Ekle</button>
                        <button class="game-btn secondary" style="width:100%;margin-top:8px;background:#222;color:#00bfff;border:1px solid #00bfff;" onclick="event.stopPropagation(); window.open('${steamUrl}','_blank')">Steam Sayfası</button>
                    </div>
                `;
            }
            
            return card;
        };

        // Oyun kartlarını paralel olarak oluştur
        const cardPromises = currentPageGames.map(game => createGameCard(game));
        const cards = await Promise.all(cardPromises);
        
        cards.forEach(card => {
            grid.appendChild(card);
        });
        onlineGrid.appendChild(grid);
        
        // Sayfalama kontrollerini ekle
        if (totalPages > 1) {
            const paginationContainer = document.createElement('div');
            paginationContainer.style.display = 'flex';
            paginationContainer.style.justifyContent = 'center';
            paginationContainer.style.alignItems = 'center';
            paginationContainer.style.gap = '12px';
            paginationContainer.style.marginTop = '32px';
            paginationContainer.style.padding = '16px';
            
            // Önceki sayfa butonu
            const prevBtn = document.createElement('button');
            prevBtn.textContent = '← Önceki';
            prevBtn.style.padding = '8px 16px';
            prevBtn.style.background = this.onlinePassCurrentPage > 0 ? '#00bfff' : '#444';
            prevBtn.style.color = '#fff';
            prevBtn.style.border = 'none';
            prevBtn.style.borderRadius = '6px';
            prevBtn.style.cursor = this.onlinePassCurrentPage > 0 ? 'pointer' : 'not-allowed';
            prevBtn.onclick = () => {
                if (this.onlinePassCurrentPage > 0) {
                    this.onlinePassCurrentPage--;
                    this.renderOnlinePassGames();
                }
            };
            
            // Sayfa bilgisi
            const pageInfo = document.createElement('span');
            pageInfo.textContent = `Sayfa ${this.onlinePassCurrentPage + 1} / ${totalPages} (${games.length} oyun)`;
            pageInfo.style.color = '#fff';
            pageInfo.style.fontSize = '14px';
            
            // Sonraki sayfa butonu
            const nextBtn = document.createElement('button');
            nextBtn.textContent = 'Sonraki →';
            nextBtn.style.padding = '8px 16px';
            nextBtn.style.background = this.onlinePassCurrentPage < totalPages - 1 ? '#00bfff' : '#444';
            nextBtn.style.color = '#fff';
            nextBtn.style.border = 'none';
            nextBtn.style.borderRadius = '6px';
            nextBtn.style.cursor = this.onlinePassCurrentPage < totalPages - 1 ? 'pointer' : 'not-allowed';
            nextBtn.onclick = () => {
                if (this.onlinePassCurrentPage < totalPages - 1) {
                    this.onlinePassCurrentPage++;
                    this.renderOnlinePassGames();
                }
            };
            
            paginationContainer.appendChild(prevBtn);
            paginationContainer.appendChild(pageInfo);
            paginationContainer.appendChild(nextBtn);
            onlineGrid.appendChild(paginationContainer);
        }
        
        // Online Ekle butonlarına event listener ekle
        document.querySelectorAll('button[data-online-add]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const appId = btn.getAttribute('data-appid');
                if (!appId) return;
                
                // Ana sürece dosya indirme isteği gönder
                try {
                    await ipcRenderer.invoke('download-online-file', appId);
                } catch (err) {
                    ui.showNotification('error', 'İndirme başarısız: ' + (err.message || err), 'error');
                }
            });
        });
    }

    getCurrentPage() {
        const active = document.querySelector('.page.active');
        if (!active) return null;
        return active.id.replace('Page', '');
    }

    async getGameImageUrl(appId, gameName) {
        // Önce CDN'den görsel almaya çalış (daha hızlı)
        const cdnUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/capsule_616x353.jpg`;
        
        try {
            const imgResponse = await fetch(cdnUrl, { method: 'HEAD' });
            if (imgResponse.ok) {
                return cdnUrl;
            }
        } catch (error) {
            console.log(`CDN'den görsel alınamadı: ${appId}`, error);
        }
        
        // CDN'den alamazsa Steam API'den dene
        try {
            const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}`);
            const data = await response.json();
            
            if (data[appId] && data[appId].success && data[appId].data) {
                const gameData = data[appId].data;
                
                // Önce header_image'i dene
                if (gameData.header_image) {
                    return gameData.header_image;
                }
                
                // Sonra capsule_image'i dene
                if (gameData.capsule_image) {
                    return gameData.capsule_image;
                }
            }
        } catch (error) {
            console.log(`Steam API'den görsel alınamadı: ${appId}`, error);
        }
        
        // Hiçbiri çalışmazsa varsayılan görsel
        return 'https://via.placeholder.com/616x353/2a2a2a/666666?text=Görsel+Yok';
    }

    setupManualInstallListeners() {
        // Önce eski event listener'ları temizle
        this.cleanupManualInstallListeners();
        
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('gameFileInput');
        const selectFileBtn = document.getElementById('selectFileBtn');
        const installGameBtn = document.getElementById('installGameBtn');

        if (uploadArea) {
            // Dosya seçme butonu
            this.manualUploadAreaHandler = () => {
                fileInput.click();
            };
            uploadArea.addEventListener('click', this.manualUploadAreaHandler);

            // Drag and drop olayları
            this.manualDragOverHandler = (e) => {
                e.preventDefault();
                uploadArea.classList.add('dragover');
            };
            uploadArea.addEventListener('dragover', this.manualDragOverHandler);

            this.manualDragLeaveHandler = () => {
                uploadArea.classList.remove('dragover');
            };
            uploadArea.addEventListener('dragleave', this.manualDragLeaveHandler);

            this.manualDropHandler = (e) => {
                e.preventDefault();
                uploadArea.classList.remove('dragover');
                const files = e.dataTransfer.files;
                if (files.length > 0) {
                    this.handleFileSelect(files[0]);
                }
            };
            uploadArea.addEventListener('drop', this.manualDropHandler);
        }

        if (selectFileBtn) {
            this.manualSelectFileHandler = (e) => {
                e.stopPropagation();
                fileInput.click();
            };
            selectFileBtn.addEventListener('click', this.manualSelectFileHandler);
        }

        if (fileInput) {
            this.manualFileInputHandler = (e) => {
                if (e.target.files.length > 0) {
                    this.handleFileSelect(e.target.files[0]);
                }
            };
            fileInput.addEventListener('change', this.manualFileInputHandler);
        }

        if (installGameBtn) {
            this.manualInstallGameHandler = () => {
                this.installManualGame();
            };
            installGameBtn.addEventListener('click', this.manualInstallGameHandler);
        }
    }

    cleanupManualInstallListeners() {
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('gameFileInput');
        const selectFileBtn = document.getElementById('selectFileBtn');
        const installGameBtn = document.getElementById('installGameBtn');

        if (uploadArea && this.manualUploadAreaHandler) {
            uploadArea.removeEventListener('click', this.manualUploadAreaHandler);
            uploadArea.removeEventListener('dragover', this.manualDragOverHandler);
            uploadArea.removeEventListener('dragleave', this.manualDragLeaveHandler);
            uploadArea.removeEventListener('drop', this.manualDropHandler);
        }

        if (selectFileBtn && this.manualSelectFileHandler) {
            selectFileBtn.removeEventListener('click', this.manualSelectFileHandler);
        }

        if (fileInput && this.manualFileInputHandler) {
            fileInput.removeEventListener('change', this.manualFileInputHandler);
        }

        if (installGameBtn && this.manualInstallGameHandler) {
            installGameBtn.removeEventListener('click', this.manualInstallGameHandler);
        }
    }

    async handleFileSelect(file) {
        if (!file.name.toLowerCase().endsWith('.zip')) {
            this.showNotification('error', 'only_zip_supported', 'error');
            return;
        }

        // Dosya bilgilerini göster
        const fileSize = (file.size / (1024 * 1024)).toFixed(2);
        const uploadArea = document.getElementById('uploadArea');
        
        uploadArea.innerHTML = `
            <div class="file-info">
                <h4>${this.translate('selected_file')}</h4>
                <p><strong>${this.translate('file_name')}:</strong> ${file.name}</p>
                <p><strong>${this.translate('size')}:</strong> ${fileSize} MB</p>
                <button class="upload-btn" id="selectAnotherFileBtn">${this.translate('select_another_file')}</button>
            </div>
        `;
        
        // Yeni butona event listener ekle
        const selectAnotherFileBtn = document.getElementById('selectAnotherFileBtn');
        if (selectAnotherFileBtn) {
            selectAnotherFileBtn.addEventListener('click', () => {
                this.selectNewFile();
            });
        }

        // Oyun bilgileri formunu göster
        document.getElementById('gameInfoSection').style.display = 'block';
        document.getElementById('installActions').style.display = 'block';

        // Dosyayı sakla
        this.selectedFile = file;

        // ZIP dosyasından oyun bilgilerini çek
        try {
            const gameInfo = await this.extractGameInfoFromZip(file);
            document.getElementById('gameNameDisplay').textContent = gameInfo.name || 'Bilinmeyen Oyun';
            document.getElementById('gameIdDisplay').textContent = gameInfo.appId || 'Bilinmeyen ID';
        } catch (error) {
            console.error('Failed to extract game info:', error);
            document.getElementById('gameNameDisplay').textContent = 'Bilinmeyen Oyun';
            document.getElementById('gameIdDisplay').textContent = 'Bilinmeyen ID';
        }
    }

    selectNewFile() {
        document.getElementById('gameFileInput').click();
    }

    async extractGameInfoFromZip(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const arrayBuffer = e.target.result;
                    const zip = await JSZip.loadAsync(arrayBuffer);
                    
                    // ZIP içindeki dosyaları kontrol et
                    const files = Object.keys(zip.files);
                    
                    // .lua dosyalarını ara (oyun ID'si için)
                    const luaFiles = files.filter(name => name.endsWith('.lua'));
                    let appId = null;
                    
                    for (const luaFile of luaFiles) {
                        const fileName = luaFile.split('/').pop().replace('.lua', '');
                        if (/^\d+$/.test(fileName)) {
                            appId = fileName;
                            break;
                        }
                    }
                    
                    // App ID'den oyun adını çek
                    let gameName = 'Bilinmeyen Oyun';
                    if (appId) {
                        try {
                            const gameDetails = await ipcRenderer.invoke('fetch-game-details', appId);
                            if (gameDetails && gameDetails.name) {
                                gameName = gameDetails.name;
                            }
                        } catch (error) {
                            console.log('Could not fetch game details for ID:', appId);
                        }
                    }
                    
                    resolve({
                        appId: appId,
                        name: gameName
                    });
                } catch (error) {
                    reject(error);
                }
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    }



    async installManualGame() {
        if (!this.selectedFile) {
            this.showNotification('error', 'please_select_file', 'error');
            return;
        }

        this.showLoading();
        try {
            const result = await ipcRenderer.invoke('install-manual-game', {
                file: this.selectedFile.path
            });

            if (result.success) {
                this.showNotification('success', 'game_installed_successfully', 'success');
                this.resetManualInstallForm();
            } else {
                this.showNotification('error', result.error || 'installation_failed', 'error');
            }
        } catch (error) {
            console.error('Failed to install manual game:', error);
            this.showNotification('error', 'installation_error', 'error');
        } finally {
            this.hideLoading();
        }
    }

    resetManualInstallForm() {
        // Event listener'ları temizle
        this.cleanupManualInstallListeners();
        
        // Formu sıfırla
        document.getElementById('gameInfoSection').style.display = 'none';
        document.getElementById('installActions').style.display = 'none';
        
        // Upload alanını geri yükle
        const uploadArea = document.getElementById('uploadArea');
        uploadArea.innerHTML = `
            <div class="upload-icon">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7,10 12,15 17,10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
            </div>
            <h3 data-i18n="upload_game_file">Oyun Dosyasını Yükle</h3>
            <p data-i18n="drag_drop_zip">ZIP dosyasını buraya sürükleyip bırakın veya tıklayarak seçin</p>
            <input type="file" id="gameFileInput" accept=".zip" style="display:none;">
            <button class="upload-btn" id="selectFileBtn" data-i18n="select_file">Dosya Seç</button>
        `;
        
        this.selectedFile = null;
        this.setupManualInstallListeners();
    }
}

// Initialize the application
const ui = new SteamLibraryUI();

// Tüm metinleri güncelleyen fonksiyon (her sayfa ve modal için)
function renderAllTexts() {
  // data-i18n ile işaretlenmiş tüm elemanları güncelle
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) {
      el.textContent = ui.translate(key);
    }
  });
  // data-i18n-placeholder ile işaretlenmiş input/textarea'ların placeholder'ını güncelle
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) {
      el.setAttribute('placeholder', ui.translate(key));
    }
  });
  // data-i18n-title ile işaretlenmiş elemanların title'ını güncelle
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (key) {
      el.setAttribute('title', ui.translate(key));
    }
  });
}
// Sayfa değişimlerinde ve dil değişiminde otomatik çağrılacak şekilde ayarla
const originalSwitchPage = SteamLibraryUI.prototype.switchPage;
SteamLibraryUI.prototype.switchPage = function(page) {
  originalSwitchPage.call(this, page);
  renderAllTexts();
};

// Sayfa yüklendiğinde eski sabit dil seçiciyi DOM'dan kaldır
window.addEventListener('DOMContentLoaded', () => {
  const oldSelector = document.getElementById('languageSelector');
  if (oldSelector) oldSelector.remove();
  ui.renderSettingsPage();
  renderAllTexts();
});

// Bayrak PNG URL'leri globalde kalsın
const languageFlagUrls = {
  tr: "https://flagcdn.com/w40/tr.png",
  en: "https://flagcdn.com/w40/gb.png",
  de: "https://flagcdn.com/w40/de.png",
  fr: "https://flagcdn.com/w40/fr.png",
  ru: "https://flagcdn.com/w40/ru.png",
  es: "https://flagcdn.com/w40/es.png",
  it: "https://flagcdn.com/w40/it.png",
  pt: "https://flagcdn.com/w40/pt.png",
  ja: "https://flagcdn.com/w40/jp.png",
  ko: "https://flagcdn.com/w40/kr.png",
  zh: "https://flagcdn.com/w40/cn.png",
  pl: "https://flagcdn.com/w40/pl.png",
};

// Dil-kodundan ülke kodu eşlemesi
const langToCountry = {
  tr: 'TR', en: 'US', de: 'DE', fr: 'FR', es: 'ES', ru: 'RU', zh: 'CN', ja: 'JP', it: 'IT', pt: 'PT', ko: 'KR', pl: 'PL'
};

// Yardımcı fonksiyon: Steam API'ye güvenli fetch
async function safeSteamFetch(url) {
    // 200ms gecikme
    await new Promise(r => setTimeout(r, 200));
    try {
        return await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
    } catch (e) {
        // fallback: User-Agent olmadan tekrar dene
        return await fetch(url);
    }
}
