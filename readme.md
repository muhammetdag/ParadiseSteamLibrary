# Paradise Steam Library

Modern Steam Kütüphane Yöneticisi - Gelişmiş özellikler ve kullanıcı dostu arayüz ile Steam oyunlarınızı yönetin.

## 🚀 Özellikler

### 📚 Steam Kütüphane Yönetimi
- **Oyun Ekleme**: Steam kütüphanenize oyun ekleyin
- **DLC Desteği**: Oyunlarla birlikte DLC'leri de ekleyin
- **Kütüphane Görüntüleme**: Mevcut oyunlarınızı görüntüleyin
- **Oyun Silme**: Kütüphaneden oyunları kaldırın

### 🌐 Online Oyun Sistemi
- **Online Pass**: Online oyunları indirin ve kurun
- **Steam API Entegrasyonu**: Gerçek oyun isimleri ve görselleri
- **Otomatik Görsel**: Steam CDN'den otomatik görsel çekme
- **Akıllı Fallback**: API hatası durumunda yedek sistem

### 🎮 Manuel Oyun Kurulumu
- **ZIP Dosyası Desteği**: Manuel ZIP dosyalarını kurun
- **Otomatik Algılama**: Oyun ID'sini otomatik algılar
- **Steam Entegrasyonu**: Steam kütüphanesine otomatik ekleme

### 🎨 Modern Arayüz
- **Dark Theme**: Göz yormayan koyu tema
- **Responsive Design**: Tüm ekran boyutlarına uyumlu
- **Animasyonlar**: Akıcı kullanıcı deneyimi
- **Türkçe Arayüz**: Tam Türkçe desteği

### 🔧 Gelişmiş Özellikler
- **Discord RPC**: Discord'da oyun durumunu göster
- **Steam Restart**: Steam'i otomatik yeniden başlat
- **Arama Sistemi**: Oyunlarda hızlı arama
- **Kategoriler**: Oyunları kategorilere göre filtrele

## 📦 Kurulum

### Gereksinimler
- Node.js 16+ 
- npm veya yarn
- Windows 10/11

### Geliştirme Ortamı
```bash
# Bağımlılıkları yükle
npm install

# Geliştirme modunda çalıştır
npm run dev

# Normal modda çalıştır
npm start
```

### Portable Build
```bash
# Portable exe oluştur
npm run build-portable

# Tüm Windows build'leri
npm run build-win

# Sadece installer
npm run build
```

## 🔄 Son Güncellemeler

### v2.0.0 - Online Sistem Güncellemesi

#### ✅ Yeni Özellikler
- **Steam API Entegrasyonu**: Online oyunlar için gerçek oyun isimleri
- **Otomatik Görsel Sistemi**: Steam CDN'den otomatik görsel çekme
- **Akıllı Hata Yönetimi**: API hatası durumunda yedek sistem
- **Portable Build Desteği**: Taşınabilir exe dosyası oluşturma

#### 🔧 Teknik İyileştirmeler
- **API Güncellemesi**: Yeni online sistem API'leri
- **Şifre Kaldırma**: ZIP ayıklama işlemlerinden şifre desteği kaldırıldı
- **Performans Optimizasyonu**: Daha hızlı oyun yükleme
- **Hata Düzeltmeleri**: Online liste yükleme sorunları çözüldü

#### 🎮 Online Oyun Sistemi
```javascript
// Yeni API Endpoints
- Liste: https://muhammetdag.com/api/v1/online/online_fix_games.json
- İndirme: https://muhammetdag.com/api/v1/online/index.php?appid=${appId}
```

#### 📱 Arayüz İyileştirmeleri
- **Oyun Kartları**: Steam API'den gerçek oyun isimleri
- **Görsel Sistemi**: Otomatik header görseli çekme
- **Loading States**: Daha iyi yükleme göstergeleri
- **Error Handling**: Kullanıcı dostu hata mesajları

## 🛠️ Teknik Detaylar

### Online Sistem Mimarisi
```javascript
// Online oyun kontrolü
const gamesResponse = await axios.get('https://muhammetdag.com/api/v1/online/online_fix_games.json');
const game = games.find(g => g.appid === parseInt(appId));

// Steam API entegrasyonu
const steamResponse = await fetch(`https://store.steampowered.com/api/appdetails?appids=${gameId}&l=turkish`);
```

### ZIP Ayıklama Sistemi
```javascript
// Şifresiz ZIP ayıklama
await this.extractZipFile(tempZipPath, targetDir);

// Fallback sistem
const targetFile = path.join(targetDir, `${game.name.replace(/[^a-zA-Z0-9]/g, '_')}.zip`);
```

### Portable Build Yapılandırması
```json
{
  "target": "portable",
  "arch": ["x64"]
}
```

## 📁 Proje Yapısı

```
Paradise Steam Library Source/
├── src/
│   ├── main.js              # Ana Electron süreci
│   ├── renderer/
│   │   ├── index.html       # Ana arayüz
│   │   ├── renderer.js      # Renderer süreci
│   │   └── styles.css       # Stil dosyası
│   ├── pdlogo.ico          # Uygulama ikonu
│   └── pdlogo.png          # Logo
├── package.json             # Proje yapılandırması
├── package-lock.json        # Bağımlılık kilidi
└── README.md               # Bu dosya
```

## 🚀 Build Komutları

### Geliştirme
```bash
npm start          # Uygulamayı çalıştır
npm run dev        # Geliştirme modu
```

### Build
```bash
npm run build-portable    # Portable exe
npm run build-win         # Windows installer
npm run build             # Tüm platformlar
npm run pack              # Paketleme
```

## 🔧 Yapılandırma

### Steam Path Ayarlama
1. Uygulamayı açın
2. Ayarlar sayfasına gidin
3. Steam klasörünü seçin
4. Değişiklikleri kaydedin

### Discord RPC
- Discord RPC otomatik olarak etkinleştirilir
- Oyun durumunuz Discord'da görünür
- Ayarlardan kapatabilirsiniz

## 🐛 Bilinen Sorunlar

- **Edge.js Bağımlılığı**: Windows'ta native modül derleme gerekebilir
- **Steam API Limitleri**: Çok fazla istek atılırsa geçici bloklanma
- **Antivirus Uyarıları**: Electron uygulamaları için yaygın

## 🤝 Katkıda Bulunma

1. Fork yapın
2. Feature branch oluşturun (`git checkout -b feature/amazing-feature`)
3. Commit yapın (`git commit -m 'Add amazing feature'`)
4. Push yapın (`git push origin feature/amazing-feature`)
5. Pull Request açın

## 📄 Lisans

Bu proje MIT lisansı altında lisanslanmıştır. Detaylar için `LICENSE` dosyasına bakın.

## 👨‍💻 Geliştirici

**Muhammet Dağ** - Modern Steam kütüphane yönetimi için geliştirilmiştir.

---

⭐ Bu projeyi beğendiyseniz yıldız vermeyi unutmayın! 