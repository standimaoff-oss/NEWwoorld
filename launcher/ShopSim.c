/* ShopSim — нативный лаунчер для Windows.
   Распаковывает встроенную игру в %LOCALAPPDATA%\ShopSim\game, поднимает
   локальный HTTP-сервер и открывает игру в окне приложения (Edge/Chrome --app).
   Собран кросс-компиляцией zig cc — настоящий PE32+ .exe, без зависимостей. */
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
extern const unsigned char game_zip[];
extern const size_t game_zip_len;

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

/* ---------- поиск браузера для окна приложения ---------- */
static int try_launch(const wchar_t *exe, const wchar_t *url) {
    wchar_t cmd[2048];
    _snwprintf(cmd, 2048, L"\"%ls\" --app=%ls --window-size=1280,760 --user-data-dir=\"%%LOCALAPPDATA%%\\ShopSim\\profile\"", exe, url);
    STARTUPINFOW si; PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof si); si.cb = sizeof si;
    if (!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) return 0;
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    return 1;
}

int WINAPI WinMain(HINSTANCE hI, HINSTANCE hP, LPSTR lpCmd, int nShow) {
    (void)hI; (void)hP; (void)lpCmd; (void)nShow;
    SetProcessDPIAware();
    WSADATA wsa; if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 1;

    /* каталог игры в профиле пользователя */
    char base[MAX_PATH];
    if (FAILED(SHGetFolderPathA(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, base))) strcpy(base, ".");
    char dir[MAX_PATH]; snprintf(dir, sizeof dir, "%s\\ShopSim", base);
    _mkdir(dir);
    char root[MAX_PATH]; snprintf(root, sizeof root, "%s\\game", dir);
    _mkdir(root);

    /* маркер версии: распаковываем один раз */
    char marker[MAX_PATH]; snprintf(marker, sizeof marker, "%s\\.version", root);
    FILE *mf = fopen(marker, "rb");
    int need = 1;
    if (mf) { char v[32] = {0}; fread(v, 1, 31, mf); fclose(mf); if (!strcmp(v, "0.6.0")) need = 0; }
    if (need) { unzip_all(game_zip, game_zip_len, root); }
    mf = fopen(marker, "wb"); if (mf) { fputs("0.6.0", mf); fclose(mf); }

    char check[MAX_PATH]; snprintf(check, sizeof check, "%s\\index.html", root);
    if (GetFileAttributesA(check) == INVALID_FILE_ATTRIBUTES) {
        MessageBoxW(NULL, L"Не удалось распаковать файлы игры.\nПопробуйте запустить программу от имени администратора.",
                    APP_TITLE, MB_ICONERROR | MB_OK);
        return 1;
    }

    CreateThread(NULL, 0, serve_thread, root, 0, NULL);
    Sleep(350);

    const wchar_t *url = L"http://127.0.0.1:8731/index.html";
    wchar_t pf[MAX_PATH]; if (!GetEnvironmentVariableW(L"ProgramFiles(x86)", pf, MAX_PATH)) GetEnvironmentVariableW(L"ProgramFiles", pf, MAX_PATH);
    wchar_t pf64[MAX_PATH]; if (!GetEnvironmentVariableW(L"ProgramFiles", pf64, MAX_PATH)) wcscpy(pf64, pf);
    wchar_t local[MAX_PATH]; GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH);

    wchar_t tries[6][MAX_PATH]; int nt = 0;
    _snwprintf(tries[nt++], MAX_PATH, L"%ls\\Microsoft\\Edge\\Application\\msedge.exe", pf);
    _snwprintf(tries[nt++], MAX_PATH, L"%ls\\Microsoft\\Edge\\Application\\msedge.exe", pf64);
    _snwprintf(tries[nt++], MAX_PATH, L"%ls\\Google\\Chrome\\Application\\chrome.exe", pf);
    _snwprintf(tries[nt++], MAX_PATH, L"%ls\\Google\\Chrome\\Application\\chrome.exe", pf64);
    _snwprintf(tries[nt++], MAX_PATH, L"%ls\\Google\\Chrome\\Application\\chrome.exe", local);

    for (int i = 0; i < nt; i++) {
        if (GetFileAttributesW(tries[i]) != INVALID_FILE_ATTRIBUTES) {
            if (try_launch(tries[i], url)) return 0;
        }
    }
    /* браузера не нашли — открываем системным */
    ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
    return 0;
}
