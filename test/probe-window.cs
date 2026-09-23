// probe-window: shows one real top-level window for the self-test, then exits.
// Usage: probe-window.exe [milliseconds] [console]
// The window sits far off-screen, has no taskbar button and never takes focus, so a run on the visible desktop (the
// known-bad control) disturbs no one. Prints one JSON line: the desktop it ran on and whether Windows called it visible.
// "console" also starts a console program (cmd /c ping) from the probe. Built as a windowed program (probe-gui.exe), the
// probe has no console of its own, so that program gets a new console window: the case of an app shelling out.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

sealed class ProbeWindow : Form
{
    protected override bool ShowWithoutActivation
    {
        get { return true; }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams parameters = base.CreateParams;
            parameters.ExStyle |= 0x80 | 0x08000000; // WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
            return parameters;
        }
    }

    [STAThread]
    static int Main(string[] args)
    {
        int milliseconds = args.Length > 0 ? int.Parse(args[0]) : 1500;
        bool console = args.Length > 1 && args[1] == "console";
        ProbeWindow window = new ProbeWindow();
        window.StartPosition = FormStartPosition.Manual;
        window.Location = new Point(-6000, -6000);
        window.Size = new Size(320, 200);
        window.ShowInTaskbar = false;
        window.Text = "offstage probe " + Process.GetCurrentProcess().Id;
        bool visible = false;
        window.Shown += delegate
        {
            visible = IsWindowVisible(window.Handle);
            if (console)
            {
                ProcessStartInfo start = new ProcessStartInfo("cmd.exe", "/c ping -n 2 127.0.0.1 >nul");
                start.UseShellExecute = false;
                start.CreateNoWindow = false;
                Process.Start(start).WaitForExit();
            }
        };
        Timer timer = new Timer();
        timer.Interval = milliseconds;
        timer.Tick += delegate { window.Close(); };
        timer.Start();
        Application.Run(window);
        Console.WriteLine("{\"desktop\":\"" + DesktopName() + "\",\"visible\":" + (visible ? "true" : "false") + ",\"title\":\"" + window.Text + "\"}");
        return 0;
    }

    static string DesktopName()
    {
        IntPtr desktop = GetThreadDesktop(GetCurrentThreadId());
        int needed;
        GetUserObjectInformationW(desktop, 2, null, 0, out needed);
        StringBuilder name = new StringBuilder(needed / 2 + 1);
        return GetUserObjectInformationW(desktop, 2, name, name.Capacity * 2, out needed) ? name.ToString() : "";
    }

    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
}
