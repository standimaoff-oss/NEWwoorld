#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "c_cad_engine.h"
#include "embedded_assets.h"

#define ID_BTN_APP     101
#define ID_BTN_BROWSER 102
#define ID_BTN_EXIT    103
#define ID_LBL_STATUS  104

static int g_port = 8420;
static int g_python_mode = 0;
static volatile int g_running = 1;
static HANDLE g_job = NULL;
static HANDLE g_child_proc = NULL;
static char g_repo_dir[MAX_PATH] = {0};
static int g_last_teeth = 24;
static double g_last_size = 80.0;

static int file_exists(const char *path) {
    DWORD a = GetFileAttributesA(path);
    return (a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY));
}

static int find_free_port(void) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return 8420;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    int port = 8420;
    if (bind(s, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
        int len = sizeof(addr);
        if (getsockname(s, (struct sockaddr *)&addr, &len) == 0) {
            port = ntohs(addr.sin_port);
        }
    }
    closesocket(s);
    return port;
}

static int tcp_port_ready(int port) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return 0;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons((u_short)port);
    int ok = (connect(s, (struct sockaddr *)&addr, sizeof(addr)) == 0);
    closesocket(s);
    return ok;
}

static void find_repo_dir(void) {
    char exe[MAX_PATH];
    GetModuleFileNameA(NULL, exe, MAX_PATH);
    char *slash = strrchr(exe, '\\');
    if (slash) *slash = '\0';

    char probe[MAX_PATH];
    snprintf(probe, sizeof(probe), "%s\\newwoorld_ai\\server.py", exe);
    if (file_exists(probe)) {
        snprintf(g_repo_dir, sizeof(g_repo_dir), "%s", exe);
        return;
    }
    snprintf(probe, sizeof(probe), "%s\\..\\newwoorld_ai\\server.py", exe);
    if (file_exists(probe)) {
        snprintf(g_repo_dir, sizeof(g_repo_dir), "%s\\..", exe);
        return;
    }
    g_repo_dir[0] = '\0';
}

static int try_launch_python_backend(int port) {
    if (!g_repo_dir[0]) return 0;

    char py_exe[MAX_PATH];
    char venv_py[MAX_PATH];
    snprintf(venv_py, sizeof(venv_py), "%s\\.venv\\Scripts\\python.exe", g_repo_dir);
    if (file_exists(venv_py)) {
        snprintf(py_exe, sizeof(py_exe), "\"%s\"", venv_py);
    } else {
        snprintf(py_exe, sizeof(py_exe), "python");
    }

    char cmd[1024];
    snprintf(cmd, sizeof(cmd), "%s -m uvicorn newwoorld_ai.server:app --host 127.0.0.1 --port %d", py_exe, port);

    g_job = CreateJobObjectA(NULL, NULL);
    if (g_job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
        memset(&jeli, 0, sizeof(jeli));
        jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
    }

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof(si));
    memset(&pi, 0, sizeof(pi));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;

    if (!CreateProcessA(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, g_repo_dir, &si, &pi)) {
        return 0;
    }

    if (g_job) AssignProcessToJobObject(g_job, pi.hProcess);
    g_child_proc = pi.hProcess;
    CloseHandle(pi.hThread);

    /* Wait up to 9s for uvicorn to bind port */
    for (int i = 0; i < 45; i++) {
        DWORD code = STILL_ACTIVE;
        if (GetExitCodeProcess(g_child_proc, &code) && code != STILL_ACTIVE) {
            return 0; /* Python or uvicorn exited immediately -> use native C fallback */
        }
        if (tcp_port_ready(port)) return 1;
        Sleep(200);
    }
    return tcp_port_ready(port);
}

/* ==================== Embedded HTTP Server (Fallback Standalone Mode) ==================== */
static void send_http_raw(SOCKET c, const char *status, const char *ctype, const char *extra_hdr, const void *body, size_t blen) {
    char hdr[1024];
    int hlen = snprintf(hdr, sizeof(hdr),
        "HTTP/1.1 %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %llu\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Connection: close\r\n"
        "%s\r\n",
        status, ctype, (unsigned long long)blen, extra_hdr ? extra_hdr : "");
    send(c, hdr, hlen, 0);
    if (blen > 0 && body) {
        size_t sent = 0;
        const char *p = (const char *)body;
        while (sent < blen) {
            int n = send(c, p + sent, (int)((blen - sent) > 65536 ? 65536 : (blen - sent)), 0);
            if (n <= 0) break;
            sent += (size_t)n;
        }
    }
}

static int json_extract_int(const char *body, const char *key, int defv) {
    if (!body) return defv;
    const char *p = strstr(body, key);
    if (!p) return defv;
    p = strchr(p, ':');
    if (!p) return defv;
    int v = atoi(p + 1);
    return v > 0 ? v : defv;
}

static double json_extract_double(const char *body, const char *key, double defv) {
    if (!body) return defv;
    const char *p = strstr(body, key);
    if (!p) return defv;
    p = strchr(p, ':');
    if (!p) return defv;
    double v = atof(p + 1);
    return v > 1.0 ? v : defv;
}

static DWORD WINAPI handle_client(LPVOID lp) {
    SOCKET c = (SOCKET)(uintptr_t)lp;
    char *req = (char *)malloc(65536);
    if (!req) { closesocket(c); return 0; }
    int total = recv(c, req, 65535, 0);
    if (total <= 0) { free(req); closesocket(c); return 0; }
    req[total] = '\0';

    char method[16] = {0}, path[256] = {0};
    sscanf(req, "%15s %255s", method, path);
    const char *body = strstr(req, "\r\n\r\n");
    if (body) body += 4;

    if (strcmp(method, "OPTIONS") == 0) {
        send_http_raw(c, "204 No Content", "text/plain",
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n", "", 0);
    } else if (strcmp(path, "/api/health") == 0) {
        const char *h =
            "{\"status\":\"ok\",\"backend\":\"native_c_fallback\","
            "\"archetypes\":[\"involute_gear\"],"
            "\"models\":{\"cadgpt\":{\"params\":1,\"trained_epochs\":0,\"last_loss\":0},"
            "\"photopart\":{\"params\":1,\"trained_epochs\":0,\"last_loss\":0},"
            "\"vision_ocr\":{\"params\":1,\"trained_epochs\":0,\"ocr_accuracy\":0,\"scene_accuracy\":0}},"
            "\"scaling_catalog\":{\"native\":{\"name\":\"Native Standalone C11 Engine\",\"exact_params\":\"Zero-Dependency .exe\",\"hardware\":\"Windows x86_64\",\"status\":\"Running (Attach Python repo for full Neural Core)\"}}}";
        send_http_raw(c, "200 OK", "application/json; charset=utf-8", NULL, h, strlen(h));
    } else if (strcmp(path, "/api/cad/generate") == 0) {
        int teeth = json_extract_int(body, "\"teeth\"", 24);
        double sz = json_extract_double(body, "\"size_mm\"", 80.0);
        g_last_teeth = teeth;
        g_last_size = sz;
        char *j = c_cad_generate_json(teeth, sz, "native_c_gear");
        if (j) { send_http_raw(c, "200 OK", "application/json; charset=utf-8", NULL, j, strlen(j)); free(j); }
    } else if (strcmp(path, "/api/cad/export/obj") == 0) {
        char *obj = c_cad_export_obj(g_last_teeth, g_last_size);
        if (obj) {
            send_http_raw(c, "200 OK", "text/plain; charset=utf-8", "Content-Disposition: attachment; filename=\"gear.obj\"\r\n", obj, strlen(obj));
            free(obj);
        }
    } else if (strcmp(path, "/api/cad/export/stl") == 0) {
        size_t slen = 0;
        uint8_t *stl = c_cad_export_stl(g_last_teeth, g_last_size, &slen);
        if (stl) {
            send_http_raw(c, "200 OK", "application/octet-stream", "Content-Disposition: attachment; filename=\"gear.stl\"\r\n", stl, slen);
            free(stl);
        }
    } else if (strcmp(path, "/api/photo/generate") == 0) {
        char *pj = c_photo_generate_json("native_c_scene");
        if (pj) { send_http_raw(c, "200 OK", "application/json; charset=utf-8", NULL, pj, strlen(pj)); free(pj); }
    } else {
        /* Serve embedded gzipped Web Studio assets */
        const char *lookup = (strcmp(path, "/") == 0) ? "/index.html" : path;
        const EmbeddedAsset *asset = find_embedded_asset(lookup);
        if (asset) {
            send_http_raw(c, "200 OK", asset->mime, "Content-Encoding: gzip\r\n", asset->data, asset->len);
        } else {
            const char *nf = "{\"error\":\"Endpoint requires full Python AI Core mode\"}";
            send_http_raw(c, "404 Not Found", "application/json", NULL, nf, strlen(nf));
        }
    }

    free(req);
    closesocket(c);
    return 0;
}

static DWORD WINAPI fallback_server_thread(LPVOID lp) {
    (void)lp;
    SOCKET srv = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (srv == INVALID_SOCKET) return 1;
    int opt = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, (const char *)&opt, sizeof(opt));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons((u_short)g_port);
    if (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) != 0) { closesocket(srv); return 1; }
    if (listen(srv, 32) != 0) { closesocket(srv); return 1; }

    while (g_running) {
        SOCKET cli = accept(srv, NULL, NULL);
        if (cli == INVALID_SOCKET) break;
        HANDLE th = CreateThread(NULL, 0, handle_client, (LPVOID)(uintptr_t)cli, 0, NULL);
        if (th) CloseHandle(th);
    }
    closesocket(srv);
    return 0;
}

/* ==================== Desktop Window Launcher ==================== */
static void open_desktop_app_window(void) {
    char url[128];
    snprintf(url, sizeof(url), "http://127.0.0.1:%d/", g_port);

    const char *candidates[] = {
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    };
    for (int i = 0; i < 3; i++) {
        if (file_exists(candidates[i])) {
            char args[256];
            snprintf(args, sizeof(args), "--app=%s --window-size=1440,900", url);
            ShellExecuteA(NULL, "open", candidates[i], args, NULL, SW_SHOWNORMAL);
            return;
        }
    }
    ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWNORMAL);
}

static void open_in_browser(void) {
    char url[128];
    snprintf(url, sizeof(url), "http://127.0.0.1:%d/", g_port);
    ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWNORMAL);
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        char info[512];
        snprintf(info, sizeof(info),
            "NEWwoorld AI Studio v1.0\r\n"
            "Mode: %s\r\n"
            "Local URL: http://127.0.0.1:%d/\r\n\r\n"
            "3D CAD Studio + Part-by-Part Photo AI + Vision/OCR",
            g_python_mode ? "Full Python Neural Core (CadGPT + PhotoPartNet + VisionOCR)"
                          : "Standalone Native C11 Engine (Zero Dependencies)",
            g_port);
        CreateWindowA("STATIC", info, WS_VISIBLE | WS_CHILD, 18, 16, 444, 88, hwnd, (HMENU)ID_LBL_STATUS, NULL, NULL);
        CreateWindowA("BUTTON", "Open Studio App", WS_VISIBLE | WS_CHILD | BS_DEFPUSHBUTTON, 18, 114, 145, 34, hwnd, (HMENU)ID_BTN_APP, NULL, NULL);
        CreateWindowA("BUTTON", "Open in Browser", WS_VISIBLE | WS_CHILD, 174, 114, 145, 34, hwnd, (HMENU)ID_BTN_BROWSER, NULL, NULL);
        CreateWindowA("BUTTON", "Exit", WS_VISIBLE | WS_CHILD, 330, 114, 130, 34, hwnd, (HMENU)ID_BTN_EXIT, NULL, NULL);
        break;
    }
    case WM_COMMAND:
        if (LOWORD(wp) == ID_BTN_APP) open_desktop_app_window();
        else if (LOWORD(wp) == ID_BTN_BROWSER) open_in_browser();
        else if (LOWORD(wp) == ID_BTN_EXIT) DestroyWindow(hwnd);
        break;
    case WM_DESTROY:
        g_running = 0;
        if (g_job) CloseHandle(g_job);
        PostQuitMessage(0);
        break;
    default:
        return DefWindowProcA(hwnd, msg, wp, lp);
    }
    return 0;
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR cmdLine, int nShow) {
    (void)hPrev; (void)cmdLine;
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);

    find_repo_dir();
    g_port = find_free_port();
    g_python_mode = try_launch_python_backend(g_port);

    if (!g_python_mode) {
        HANDLE sth = CreateThread(NULL, 0, fallback_server_thread, NULL, 0, NULL);
        if (sth) CloseHandle(sth);
        Sleep(120);
    }

    WNDCLASSA wc;
    memset(&wc, 0, sizeof(wc));
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInst;
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    wc.hCursor = LoadCursorA(NULL, IDC_ARROW);
    wc.lpszClassName = "NEWwoorldStudioClass";
    RegisterClassA(&wc);

    HWND hwnd = CreateWindowA(
        "NEWwoorldStudioClass",
        "NEWwoorld AI Studio — Control Center",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
        CW_USEDEFAULT, CW_USEDEFAULT, 494, 200,
        NULL, NULL, hInst, NULL);
    ShowWindow(hwnd, nShow);
    UpdateWindow(hwnd);

    /* Automatically launch Studio desktop app window on startup */
    open_desktop_app_window();

    MSG msg;
    while (GetMessageA(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageA(&msg);
    }

    WSACleanup();
    return 0;
}
