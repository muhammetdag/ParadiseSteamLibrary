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

## [v2.0.1] - 04.08.2025

### 🐛 Bug Fixes
- **OnlinePass Arama Sistemi**: Online Pass sayfasında oyun arama sorunu çözüldü
  - Hem oyun ID'si hem oyun ismi ile arama yapılabilir
  - Steam API'den oyun isimleri otomatik çekilir ve önbelleklenir
  - Arama performansı iyileştirildi
- **Kütüphane Bug'u**: Kütüphane yükleme ve görüntüleme sorunları düzeltildi
  - `appendChild` hataları çözüldü
  - Asenkron oyun kartı oluşturma iyileştirildi
  - Null kontrolleri eklendi

### ✨ New Features
- **Gelişmiş Online Pass Arama**: 
  - Çift arama sistemi (ID + İsim)
  - Otomatik oyun ismi önbellekleme
  - Paralel Steam API çağrıları
  - Hızlı ve responsive arama

### 🔧 Technical Improvements
- **Asenkron İşlemler**: Oyun kartı oluşturma işlemleri optimize edildi
- **Hata Yönetimi**: Robust error handling eklendi
- **Performans**: Online Pass sayfası yükleme hızı artırıldı

### 📝 Examples
```
ID Arama: "240" → 2406770, 240760
İsim Arama: "bodycam" → BODYCAM
İsim Arama: "euro" → Euro Truck Simulator 2
İsim Arama: "ready" → Ready or Not
```

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
