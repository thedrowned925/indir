# indir ⬇

**yt-dlp + ffmpeg** ile YouTube, Instagram, TikTok, X, Twitch, SoundCloud ve 1800'den fazla siteden video/ses indiren, **tamamen GitHub üzerinde** çalışan site.

- **Site:** GitHub Pages (`site/` klasörü) → `https://<kullanıcı>.github.io/indir/`
- **Sunucu:** GitHub Actions (`.github/workflows/indir.yml`) — yt-dlp ve ffmpeg burada çalışır
- **Dosyalar:** GitHub Releases'e yüklenir, sitede indirme düğmesi çıkar

## Özellikler

| Video | Ses |
|---|---|
| 8K, 4K, 1440p, 1080p, 720p, 480p, 360p, 240p, 144p, en iyi | MP3, M4A (AAC), AAC, Opus, OGG Vorbis |
| MP4, MKV, WebM, MOV | **FLAC, WAV, ALAC** (kayıpsız) |
| H.264, H.265, VP9, AV1, “uyumlu” (H.264+AAC) | 64–320 kbps CBR veya V0–V7 VBR |
| FPS sınırı (60/30) | 22.05 / 44.1 / 48 / 88.2 / 96 / 192 kHz |
| Altyazı (göm ya da SRT), otomatik altyazı | 16 / 24 / 32-bit (FLAC/WAV/ALAC) |
| “Formatları getir” → tüm format tablosundan seçim | Stereo / mono |

Ortak: kırpma (başlangıç–bitiş), oynatma listesi, SponsorBlock ile sponsor/intro kesme, kapak resmi, meta veri ve bölüm gömme. 2 GB'tan büyük dosyalar otomatik parçalanır.

## Kurulum (bir kez, ~2 dakika)

1. **Pages'i aç:** Depo → *Settings* → *Pages* → *Source*: **GitHub Actions**.
2. **Actions'ı çalıştır:** *Actions* sekmesi → **site** iş akışı → *Run workflow*. (Sonraki her push'ta kendiliğinden yayınlanır.)
3. Siteyi aç: `https://<kullanıcı>.github.io/indir/`
4. *(Önerilir)* Sitede **⚙ Ayarlar** → fine-grained token gir
   ([buradan oluştur](https://github.com/settings/personal-access-tokens/new): yalnızca bu depo, **Issues: Read and write**).
   Token olmadan da çalışır; o zaman her indirmede açılan GitHub sekmesinde *Submit new issue*'ya basman gerekir.

> İş akışları yalnızca **varsayılan daldaki** dosyalardan çalışır. Bu dosyalar başka bir daldaysa önce varsayılan dala birleştir.

## Nasıl çalışır?

```
Site ──(issue: "[indir] …" + JSON istek)──▶ GitHub Actions
                                              │ yt-dlp + ffmpeg
                                              ▼
Site ◀──(issue yorumu: dosya bağlantıları)── Release "indir-<no>"
```

Site statik olduğu için indirmeyi kendisi yapamaz; isteği bir issue olarak gönderir, Actions çalıştırır, sonucu yorum olarak yazar. Site yorumları okuyup indirme düğmelerini gösterir.

## Ayarlar (isteğe bağlı)

*Settings → Secrets and variables → Actions*

| Ad | Tür | Açıklama |
|---|---|---|
| `YTDLP_COOKIES` | Secret | Netscape formatında tarayıcı çerezleri. YouTube “Sign in to confirm you're not a bot” derse veya yaş/üyelik kısıtlı videolar için gerekir. Çerezleri “Get cookies.txt LOCALLY” gibi bir eklentiyle dışa aktarıp içeriğini yapıştır. **Ana hesabın yerine yan bir hesap kullan.** |
| `INDIR_ALLOWED` | Variable | Depo sahibi dışında kimler kullanabilir: `kullanici1,kullanici2` ya da herkes için `*`. Varsayılan: yalnızca depo sahibi. |
| `INDIR_KEEP_DAYS` | Variable | İndirilen dosyalar kaç gün saklansın (varsayılan 3). `temizlik` iş akışı her gün eskileri siler. |

## Notlar

- Depo **public** olmalı (Release dosyalarının giriş yapmadan inmesi ve Pages için).
- GitHub sunucuları veri merkezi IP'si kullandığından bazı siteler (özellikle YouTube) zaman zaman engelleyebilir; çözüm `YTDLP_COOKIES`.
- Bir iş en fazla 2 saat sürebilir; çok uzun oynatma listelerini parça parça indir.
- Yalnızca indirme hakkına sahip olduğun içerikler için kullan; GitHub'ın kabul edilebilir kullanım kurallarına uy.
