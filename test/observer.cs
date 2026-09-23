// observer: records every top-level window shown on the desktop it runs on, for the self-test.
// Usage: observer.exe <out.jsonl> <stop-file>
// Writes one JSON line per window shown (a WinEvent hook, so a window that flashes for a moment is still caught) until the
// stop file exists, then exits. The first line is {"ready":true,...} once the hook is in place.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Observer
{
    static StreamWriter output;
    static WinEventProc onEvent;

    static int Main(string[] args)
    {
        if (args.Length != 2)
        {
            Console.Error.WriteLine("usage: observer.exe <out.jsonl> <stop-file>");
            return 2;
        }
        output = new StreamWriter(args[0], false, new UTF8Encoding(false));
        output.AutoFlush = true;
        onEvent = OnEvent;
        IntPtr hook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero, onEvent, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        if (hook == IntPtr.Zero)
        {
            Console.Error.WriteLine("observer: SetWinEventHook failed");
            return 3;
        }
        output.WriteLine("{\"ready\":true,\"desktop\":" + Json(DesktopName()) + "}");
        uint thread = GetCurrentThreadId();
        string stopFile = args[1];
        Timer poll = new Timer(delegate
        {
            if (File.Exists(stopFile)) PostThreadMessageW(thread, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        }, null, 100, 100);
        MSG message;
        while (GetMessageW(out message, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessageW(ref message);
        }
        poll.Dispose();
        UnhookWinEvent(hook);
        output.Close();
        return 0;
    }

    static void OnEvent(IntPtr hook, uint eventType, IntPtr window, int idObject, int idChild, uint thread, uint time)
    {
        if (window == IntPtr.Zero || idObject != OBJID_WINDOW || idChild != CHILDID_SELF) return;
        if (GetAncestor(window, GA_ROOT) != window) return;
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        StringBuilder title = new StringBuilder(512);
        InternalGetWindowText(window, title, title.Capacity);
        StringBuilder className = new StringBuilder(256);
        GetClassNameW(window, className, className.Capacity);
        RECT r;
        GetWindowRect(window, out r);
        output.WriteLine("{\"at\":" + Environment.TickCount + ",\"pid\":" + pid + ",\"process\":" + Json(ProcessName(pid))
            + ",\"class\":" + Json(className.ToString()) + ",\"title\":" + Json(title.ToString())
            + ",\"rect\":[" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom + "]}");
    }

    static string DesktopName()
    {
        IntPtr desktop = GetThreadDesktop(GetCurrentThreadId());
        int needed;
        GetUserObjectInformationW(desktop, 2, null, 0, out needed);
        StringBuilder name = new StringBuilder(needed / 2 + 1);
        return GetUserObjectInformationW(desktop, 2, name, name.Capacity * 2, out needed) ? name.ToString() : "";
    }

    static string ProcessName(uint pid)
    {
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) return "pid " + pid;
        try
        {
            StringBuilder path = new StringBuilder(1024);
            int size = path.Capacity;
            return QueryFullProcessImageNameW(handle, 0, path, ref size) ? Path.GetFileName(path.ToString()) : "pid " + pid;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    static string Json(string text)
    {
        StringBuilder json = new StringBuilder("\"");
        foreach (char c in text)
        {
            if (c == '"' || c == '\\') json.Append('\\').Append(c);
            else if (c < ' ') json.Append("\\u").Append(((int)c).ToString("x4"));
            else json.Append(c);
        }
        return json.Append('"').ToString();
    }

    const uint EVENT_OBJECT_SHOW = 0x8002;
    const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    const int OBJID_WINDOW = 0;
    const int CHILDID_SELF = 0;
    const uint GA_ROOT = 2;
    const uint WM_QUIT = 0x0012;

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam, lParam;
        public uint time;
        public int x, y;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT
    {
        public int Left, Top, Right, Bottom;
    }

    delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr window, int idObject, int idChild, uint thread, uint time);

    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventProc callback, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessageW(out MSG message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG message);
    [DllImport("user32.dll")] static extern bool PostThreadMessageW(uint thread, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int InternalGetWindowText(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
}
