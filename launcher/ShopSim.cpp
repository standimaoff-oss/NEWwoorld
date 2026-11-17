/* ShopSim — нативное приложение для Windows.
   Распаковывает встроенную игру в %LOCALAPPDATA%\ShopSim\game, поднимает
   локальный HTTP-сервер и показывает игру в собственном окне через WebView2.
   Это не «запуск браузера»: окно принадлежит приложению, своего браузерного
   интерфейса нет, иконка и заголовок — от игры. */
#define _CRT_SECURE_NO_WARNINGS
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shlobj.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <direct.h>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "shell32.lib")

#define PORT 8731
#define APP_TITLE L"ShopSim"

/* ---- встроенные ресурсы игры (генерируются embed.c) ---- */
extern "C" {
  extern const unsigned char game_zip[];
  extern const size_t game_zip_len;
}

#define GAME_VERSION "0.7.0"

/* ---------- распаковка zip (только stored, без сжатия) ---------- */
typedef struct { char name[256]; unsigned int size; unsigned int offset; } ZipEnt;

static int unzip_all(const unsigned char *z, size_t zlen, const char *outdir) {
    if (zlen < 22 || z[0] != 'P' || z[1] != 'K') return 0;
    /* ПК: ищем End of Central Directory */
    long eocd = -1;
    for (long i = (long)zlen - 22; i >= 0 && i > (long)zlen - 66000; i--) {
        if (z[i] == 'P' && z[i+1] == 'K' && z[i+2] == 5 && z[i+3] == 6) { eocd = i; break; }
    }
    if (eocd < 0) return 0;
    unsigned short nent = *(unsigned short *)(z + eocd + 10);
    unsigned int cdoff = *(unsigned int *)(z + eocd + 16);
    unsigned int p = cdoff;
    for (unsigned short n = 0; n < nent; n++) {
        if (p + 46 > zlen || z[p] != 'P' || z[p+1] != 'K' || z[p+2] != 1 || z[p+3] != 2) break;
        unsigned short method = *(unsigned short *)(z + p + 10);
        unsigned int csize  = *(unsigned int   *)(z + p + 20);
        unsigned int usize  = *(unsigned int   *)(z + p + 24);
        unsigned short nlen  = *(unsigned short *)(z + p + 28);
        unsigned short elen  = *(unsigned short *)(z + p + 30);
        unsigned short clen  = *(unsigned short *)(z + p + 32);
        unsigned int lho    = *(unsigned int   *)(z + p + 42);
        char name[512]; memcpy(name, z + p + 46, nlen); name[nlen] = 0;
        p += 46 + nlen + elen + clen;
        if (method != 0) continue;                 /* только stored */
        if (name[nlen-1] == '/') {                 /* каталог */
            char d[1024]; snprintf(d, sizeof d, "%s\\%s", outdir, name);
            for (char *q = d; *q; q++) if (*q == '/') *q = '\\';
            d[strlen(d)-1] = 0; _mkdir(d);
            continue;
        }
        if (lho + 30 > zlen) continue;
        unsigned short lnlen = *(unsigned short *)(z + lho + 26);
        unsigned short lelen = *(unsigned short *)(z + lho + 28);
        const unsigned char *data = z + lho + 30 + lnlen + lelen;
        if ((unsigned int)(data - z) + usize > zlen) continue;
        char path[1024]; snprintf(path, sizeof path, "%s\\%s", outdir, name);
        for (char *q = path; *q; q++) if (*q == '/') *q = '\\';
        /* создаём вложенные каталоги */
        for (char *q = path + strlen(outdir) + 1; *q; q++) {
            if (*q == '\\') { *q = 0; _mkdir(path); *q = '\\'; }
        }
        FILE *f = fopen(path, "wb");
        if (f) { fwrite(data, 1, usize, f); fclose(f); }
    }
    return 1;
}

/* ---------- HTTP-сервер ---------- */
static const char *mime_for(const char *p) {
    const char *e = strrchr(p, '.');
    if (!e) return "application/octet-stream";
    if (!_stricmp(e, ".html")) return "text/html; charset=utf-8";
    if (!_stricmp(e, ".js"))   return "text/javascript; charset=utf-8";
    if (!_stricmp(e, ".css"))  return "text/css; charset=utf-8";
    if (!_stricmp(e, ".json")) return "application/json; charset=utf-8";
    if (!_stricmp(e, ".webmanifest")) return "application/manifest+json";
    if (!_stricmp(e, ".png"))  return "image/png";
    if (!_stricmp(e, ".jpg"))  return "image/jpeg";
    if (!_stricmp(e, ".svg"))  return "image/svg+xml";
    if (!_stricmp(e, ".ico"))  return "image/x-icon";
    return "application/octet-stream";
}

static DWORD WINAPI serve_thread(LPVOID arg) {
    const char *root = (const char *)arg;
    SOCKET srv = socket(AF_INET, SOCK_STREAM, 0);
    if (srv == INVALID_SOCKET) return 0;
    int yes = 1; setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, (char*)&yes, sizeof yes);
    struct sockaddr_in a; memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons(PORT);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(srv, (struct sockaddr*)&a, sizeof a) != 0) return 0;
    listen(srv, 16);
    for (;;) {
        SOCKET c = accept(srv, NULL, NULL);
        if (c == INVALID_SOCKET) continue;
        char buf[4096]; int n = recv(c, buf, sizeof buf - 1, 0);
        if (n <= 0) { closesocket(c); continue; }
        buf[n] = 0;
        char method[8] = {0}, url[1024] = {0};
        sscanf(buf, "%7s %1023s", method, url);
        char *qs = strchr(url, '?'); if (qs) *qs = 0;
        char *dec = url;
        for (char *q = dec; *q; q++) if (*q == '%' && q[1] && q[2]) {
            int v; sscanf(q + 1, "%2x", &v); *q = (char)v; memmove(q + 1, q + 3, strlen(q + 3) + 1);
        }
        if (!strcmp(dec, "/")) strcpy(dec, "/index.html");
        char path[1400];
        snprintf(path, sizeof path, "%s%s", root, dec);
        FILE *f = fopen(path, "rb");
        if (!f) {
            const char *nf = "HTTP/1.1 404 Not Found\r\nContent-Length: 3\r\nConnection: close\r\n\r\n404";
            send(c, nf, (int)strlen(nf), 0); closesocket(c); continue;
        }
        fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
        char hdr[512];
        int hl = snprintf(hdr, sizeof hdr,
            "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %ld\r\n"
            "Cache-Control: no-cache\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
            mime_for(path), sz);
        send(c, hdr, hl, 0);
        char *cb = (char*)malloc(65536); long left = sz;
        while (left > 0) {
            int r = (int)fread(cb, 1, left > 65536 ? 65536 : left, f);
            if (r <= 0) break;
            if (send(c, cb, r, 0) <= 0) break;
            left -= r;
        }
        free(cb); fclose(f);
        closesocket(c);
    }
    return 0;
}


/* ---------- нативное окно с WebView2 ---------- */
#include "webview/webview.h"

/* Путь к папке игры в профиле пользователя. Возвращает 1 при успехе. */
static int prepare_game(char *root, size_t rootlen) {
    char base[MAX_PATH];
    if (FAILED(SHGetFolderPathA(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, base))) strcpy(base, ".");
    char dir[MAX_PATH];
    snprintf(dir, sizeof dir, "%s\\ShopSim", base);
    _mkdir(dir);
    snprintf(root, rootlen, "%s\\game", dir);
    _mkdir(root);

    char marker[MAX_PATH];
    snprintf(marker, sizeof marker, "%s\\.version", root);
    FILE *mf = fopen(marker, "rb");
    int need = 1;
    if (mf) {
        char v[32] = {0};
        fread(v, 1, 31, mf);
        fclose(mf);
        if (!strcmp(v, GAME_VERSION)) need = 0;
    }
    if (need) unzip_all(game_zip, game_zip_len, root);
    mf = fopen(marker, "wb");
    if (mf) { fputs(GAME_VERSION, mf); fclose(mf); }

    char check[MAX_PATH];
    snprintf(check, sizeof check, "%s\\index.html", root);
    return GetFileAttributesA(check) != INVALID_FILE_ATTRIBUTES;
}

int WINAPI WinMain(HINSTANCE hI, HINSTANCE hP, LPSTR lpCmd, int nShow) {
    (void)hI; (void)hP; (void)lpCmd; (void)nShow;

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 1;

    char root[MAX_PATH];
    if (!prepare_game(root, sizeof root)) {
        MessageBoxW(NULL,
            L"Не удалось распаковать файлы игры.\n"
            L"Попробуйте запустить программу от имени администратора\n"
            L"или проверьте свободное место на диске.",
            APP_TITLE, MB_ICONERROR | MB_OK);
        return 1;
    }

    /* Сервер отдаёт файлы игры на loopback — ES-модули не работают по file:// */
    CreateThread(NULL, 0, serve_thread, root, 0, NULL);
    Sleep(300);

    try {
        webview::webview w(false, nullptr);
        w.set_title("ShopSim — симулятор магазина");
        // Иконка приложения: ресурс #1 из res.rc, крупная и мелкая.
        auto win = w.window();
        if (HWND hwnd = win.ok() ? (HWND)win.value() : nullptr) {
            HINSTANCE inst = GetModuleHandleW(NULL);
            HICON big = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, 32, 32, LR_DEFAULTCOLOR);
            HICON small = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, 16, 16, LR_DEFAULTCOLOR);
            if (big) SendMessageW(hwnd, WM_SETICON, ICON_BIG, (LPARAM)big);
            if (small) SendMessageW(hwnd, WM_SETICON, ICON_SMALL, (LPARAM)small);
        }
        w.set_size(1280, 760, WEBVIEW_HINT_NONE);
        w.set_size(1000, 620, WEBVIEW_HINT_MIN);
        w.navigate("http://127.0.0.1:8731/index.html");
        w.run();
    } catch (const std::exception &e) {
        /* WebView2 не установлен — сообщаем и предлагаем скачать */
        std::string msg = std::string("Не удалось открыть окно игры:\n") + e.what() +
            "\n\nДля работы нужен Microsoft Edge WebView2 Runtime.\n"
            "Он предустановлен в Windows 11 и в большинстве сборок Windows 10.\n"
            "Скачать: https://developer.microsoft.com/microsoft-edge/webview2/";
        MessageBoxA(NULL, msg.c_str(), "ShopSim", MB_ICONERROR | MB_OK);
        return 1;
    }
    return 0;
}
