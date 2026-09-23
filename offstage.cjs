#!/usr/bin/env node
'use strict'
// offstage-windows 0.1.1 (MIT; offstage-windows on npm and GitHub): runs the windows of automated desktop-app sessions
// (Electron e2e, CDP screenshot scripts, packaged smoke tests) on a hidden Windows desktop, so nothing flashes on screen
// and nothing steals focus.
//
// Install it from npm (offstage-windows), or copy this file (and offstage.d.cts in a TypeScript project) into a project
// unchanged. On Windows the first call compiles a small helper with the C# compiler that ships with Windows (.NET Framework
// 4, csc.exe) into %LOCALAPPDATA%\offstage (or OFFSTAGE_CACHE); elsewhere every function passes the command through
// unchanged. If the helper cannot be built or its first run fails, offstage says so once and the windows show as before.
//
//   Playwright:  await _electron.launch(electronLaunchOptions({ args: ['.'], env }))
//   spawn:       spawn(...spawnArgs(electronBinary, ['.', '--remote-debugging-port=9222']), { stdio: 'ignore' })
//                (spawnArgs(file, args, { waitForAll: true }) for an app that restarts itself or hands over)
//   any command: npx offstage-windows [--timeout <seconds>] [--wait-all] [--keep-orphans] [--verbose] [--] <command> [args...]
//                (node offstage.cjs ... when the file is copied into a project)
//   health:      npx offstage-windows --check
//
// OFFSTAGE=0 shows the windows again (to watch a run). OFFSTAGE_VERBOSE=1 prints what each run opened offstage and what
// it left running. Human-facing launches (a dev server's window, the installed app) must never go through offstage.
const { spawn, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HELPER_SOURCE = String.raw`// offstage: runs a command on a hidden desktop, so the windows it and its children open never appear on screen.
// C# 5 for the .NET Framework 4 compiler that ships with Windows (csc.exe); offstage.cjs compiles it on first use.
//
//   offstage.exe [--timeout <seconds>] [--wait-all] [--keep-orphans] [--desktop <name> | --own-desktop] [--verbose] -- <command line>
//       Runs the command line (passed on verbatim) on a new hidden desktop and exits with its exit code. --own-desktop makes
//       a new one even when started from inside another offstage run (an app launch: every app gets a desktop, and so a
//       focus, of its own; OFFSTAGE_OWN_DESKTOP=1 in stand-in mode). --desktop runs it
//       on an existing one instead: a helper that works with an app's windows by handle must share the app's desktop
//       (from any other desktop the handle reads as an empty, hidden window).
//   OFFSTAGE_EXEC=<exe> [OFFSTAGE_EXEC_PREPEND=<args>] offstage.exe <args>
//       Stand-in mode: runs "<exe> <prepend> <args>" the same way, for tools that start one executable themselves
//       (Playwright's executablePath). Every argument is the target's, so the options come from OFFSTAGE_TIMEOUT,
//       OFFSTAGE_WAIT_ALL, OFFSTAGE_KEEP_ORPHANS, OFFSTAGE_OWN_DESKTOP and OFFSTAGE_VERBOSE. The run also ends when the
//       process that started the helper does.
//
// The command inherits this process's standard handles, environment and working directory, plus OFFSTAGE_DESKTOP (the
// desktop's name). Started from a process that already runs offstage, it uses that desktop instead of making another,
// unless --own-desktop (or --desktop) says otherwise.
// Everything the command starts runs in a job object: when the command exits, whatever it left running is stopped
// (after a short grace period; --keep-orphans leaves it), and if this process is killed, the whole tree goes with it.
// --wait-all waits for the whole tree instead, for a program that restarts itself or hands over to another process.
// Exit codes: the command's own, or 124 timed out, 125 offstage failed, 126 could not start, 127 not found.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Offstage
{
    const int ExitTimedOut = 124;
    const int ExitFailed = 125;
    const int ExitCannotRun = 126;
    const int ExitNotFound = 127;
    const uint ExitStopped = 1;
    const uint ExitInterrupted = 130;

    sealed class Options
    {
        public int TimeoutSeconds;
        public bool WaitAll;
        public string Desktop = "";
        public bool OwnDesktop;
        public bool KeepOrphans;
        public bool Verbose;
    }

    sealed class Window
    {
        public string Title = "";
        public string ClassName = "";
        public string Process = "";
    }

    sealed class Refusal : Exception
    {
        public readonly int Code;
        public Refusal(int code, string message) : base(message) { Code = code; }
    }

    static IntPtr job;
    static volatile bool finished;
    static readonly ManualResetEvent stopCensus = new ManualResetEvent(false);
    static ConsoleCtrlHandler controlHandler;
    static EnumWindowsProc noteWindow;
    static readonly Dictionary<long, Window> seen = new Dictionary<long, Window>();

    static int Main()
    {
        try
        {
            return Run();
        }
        catch (Refusal e)
        {
            Console.Error.WriteLine("offstage: " + e.Message);
            return e.Code;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("offstage: " + e.Message);
            return ExitFailed;
        }
    }

    static int Run()
    {
        Options options = new Options();
        string rest = AfterProgramName(Marshal.PtrToStringUni(GetCommandLineW()));
        string target = Environment.GetEnvironmentVariable("OFFSTAGE_EXEC");
        string commandLine;
        if (!string.IsNullOrEmpty(target))
        {
            string prepend = Environment.GetEnvironmentVariable("OFFSTAGE_EXEC_PREPEND") ?? "";
            commandLine = Quote(target);
            if (prepend.Length > 0) commandLine += " " + prepend;
            if (rest.Length > 0) commandLine += " " + rest;
            options.TimeoutSeconds = Seconds(Environment.GetEnvironmentVariable("OFFSTAGE_TIMEOUT"), "OFFSTAGE_TIMEOUT");
            options.WaitAll = IsOn(Environment.GetEnvironmentVariable("OFFSTAGE_WAIT_ALL"));
            options.KeepOrphans = IsOn(Environment.GetEnvironmentVariable("OFFSTAGE_KEEP_ORPHANS"));
            options.OwnDesktop = IsOn(Environment.GetEnvironmentVariable("OFFSTAGE_OWN_DESKTOP"));
        }
        else
        {
            commandLine = ParseOptions(rest, options);
        }
        if (IsOn(Environment.GetEnvironmentVariable("OFFSTAGE_VERBOSE"))) options.Verbose = true;
        Environment.SetEnvironmentVariable("OFFSTAGE_EXEC", null);
        Environment.SetEnvironmentVariable("OFFSTAGE_EXEC_PREPEND", null);
        Environment.SetEnvironmentVariable("OFFSTAGE_TIMEOUT", null);
        Environment.SetEnvironmentVariable("OFFSTAGE_WAIT_ALL", null);
        Environment.SetEnvironmentVariable("OFFSTAGE_KEEP_ORPHANS", null);
        Environment.SetEnvironmentVariable("OFFSTAGE_OWN_DESKTOP", null);

        IntPtr ownDesktop = GetThreadDesktop(GetCurrentThreadId());
        string current = ObjectName(ownDesktop);
        string inherited = Environment.GetEnvironmentVariable("OFFSTAGE_DESKTOP");
        // Nested: already on the desktop to run on. An explicit --desktop decides that by itself; --own-desktop always
        // makes a new one; otherwise a process started from inside an offstage run stays on that run's desktop.
        bool nested = options.Desktop.Length > 0
            ? string.Equals(options.Desktop, current, StringComparison.OrdinalIgnoreCase)
            : !options.OwnDesktop && !string.IsNullOrEmpty(inherited) && string.Equals(inherited, current, StringComparison.OrdinalIgnoreCase);
        string desktopName = current;
        IntPtr hidden = IntPtr.Zero;
        IntPtr desktopArgument = IntPtr.Zero;
        if (!nested && options.Desktop.Length > 0)
        {
            desktopName = options.Desktop;
            hidden = OpenDesktopW(desktopName, 0, false, GENERIC_ALL);
            if (hidden == IntPtr.Zero) throw new Refusal(ExitFailed, "there is no desktop named " + desktopName + " to run on: " + LastError());
            desktopArgument = Marshal.StringToHGlobalUni(ObjectName(GetProcessWindowStation()) + "\\" + desktopName);
            Environment.SetEnvironmentVariable("OFFSTAGE_DESKTOP", desktopName);
        }
        else if (!nested)
        {
            desktopName = "offstage-" + GetCurrentProcessId() + "-" + ((uint)Environment.TickCount).ToString("x");
            hidden = CreateDesktopW(desktopName, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
            if (hidden == IntPtr.Zero) throw new Refusal(ExitFailed, "could not create a hidden desktop: " + LastError());
            desktopArgument = Marshal.StringToHGlobalUni(ObjectName(GetProcessWindowStation()) + "\\" + desktopName);
            Environment.SetEnvironmentVariable("OFFSTAGE_DESKTOP", desktopName);
        }

        if (nested) Environment.SetEnvironmentVariable("OFFSTAGE_DESKTOP", current);

        // Kill-on-close holds even with --keep-orphans, so killing this process always stops the tree; --keep-orphans
        // lifts it only once the command has exited on its own.
        job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Refusal(ExitFailed, "could not create a job object: " + LastError());
        if (!SetJobLimits(job, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE))
            throw new Refusal(ExitFailed, "could not set up the job object: " + LastError());

        PROCESS_INFORMATION process;
        try
        {
            process = Start(commandLine, desktopArgument);
        }
        finally
        {
            if (desktopArgument != IntPtr.Zero) Marshal.FreeHGlobal(desktopArgument);
        }
        bool tracked = AssignProcessToJobObject(job, process.hProcess);
        if (!tracked)
            Console.Error.WriteLine("offstage: the command runs outside a job object (" + LastError() + "), so what it leaves running is not stopped, and stopping offstage does not stop it");
        ResumeThread(process.hThread);
        CloseHandle(process.hThread);

        controlHandler = OnConsoleControl;
        SetConsoleCtrlHandler(controlHandler, true);

        // A stand-in is the executable a tool started (Playwright's executablePath), and such a tool never wants the app
        // to outlive it. Playwright on Windows starts it through cmd.exe, whose children leave Node's own kill-on-close
        // job, so a test worker that is killed outright would leave the app running on a desktop no one can see: the run
        // ends when the process that started the helper does.
        if (!string.IsNullOrEmpty(target)) WatchParent();

        IntPtr censusDesktop = hidden != IntPtr.Zero ? hidden : ownDesktop;
        noteWindow = NoteWindow;
        Thread census = new Thread(delegate ()
        {
            while (!finished)
            {
                EnumDesktopWindows(censusDesktop, noteWindow, IntPtr.Zero);
                stopCensus.WaitOne(100);
            }
        });
        census.IsBackground = true;
        census.Start();

        int exitCode = 0;
        uint started = (uint)Environment.TickCount;
        uint limit = options.TimeoutSeconds > 0 ? (uint)options.TimeoutSeconds * 1000u : INFINITE;
        bool timedOut = WaitForSingleObject(process.hProcess, limit) == WAIT_TIMEOUT;
        if (!timedOut)
        {
            uint code;
            GetExitCodeProcess(process.hProcess, out code);
            exitCode = unchecked((int)code);
            if (options.WaitAll && tracked)
                while (!timedOut && JobProcessIds(job).Count > 0)
                {
                    Thread.Sleep(20);
                    timedOut = limit != INFINITE && unchecked((uint)Environment.TickCount - started) >= limit;
                }
        }
        if (timedOut)
        {
            Console.Error.WriteLine("offstage: timed out after " + options.TimeoutSeconds + " s" + OpenWindows(censusDesktop, desktopName));
            if (!tracked || !TerminateJobObject(job, ExitTimedOut)) TerminateProcess(process.hProcess, ExitTimedOut);
            WaitForSingleObject(process.hProcess, 5000);
            exitCode = ExitTimedOut;
        }
        finished = true;
        stopCensus.Set();
        census.Join(2000);

        List<string> leftovers = new List<string>();
        if (tracked && !timedOut)
        {
            // Chromium's helper processes follow their browser process out within moments; give them up to 2 s, looking
            // every 10 ms so that a run ends as soon as they have (a deadline, not a count: a 10 ms sleep can last 15 ms).
            uint graceFrom = (uint)Environment.TickCount;
            if (!options.KeepOrphans)
                while (unchecked((uint)Environment.TickCount - graceFrom) < 2000 && JobProcessIds(job).Count > 0) Thread.Sleep(10);
            foreach (uint pid in JobProcessIds(job)) leftovers.Add(ProcessName(pid));
            if (leftovers.Count > 0 && !options.KeepOrphans)
            {
                TerminateJobObject(job, ExitStopped);
                Console.Error.WriteLine("offstage: stopped " + Count(leftovers.Count, "process", "processes") + " the command left running: " + Tally(leftovers));
            }
            else if (leftovers.Count > 0 && options.Verbose)
            {
                Console.Error.WriteLine("offstage: left running as asked: " + Tally(leftovers));
            }
        }

        if (options.Verbose)
        {
            List<string> opened = new List<string>();
            lock (seen) foreach (Window w in seen.Values) opened.Add(w.Process + " \"" + w.Title + "\"");
            Console.Error.WriteLine("offstage: " + (nested ? "ran on the offstage desktop it was started from, " : "desktop ") + desktopName
                + "; " + Count(opened.Count, "window", "windows") + " opened there" + (opened.Count > 0 ? ": " + Tally(opened) : ""));
        }
        string reportDirectory = Environment.GetEnvironmentVariable("OFFSTAGE_REPORT_DIR");
        // A report that cannot be written never changes the run's outcome: the exit code and what is kept stay the command's.
        if (!string.IsNullOrEmpty(reportDirectory))
        {
            try
            {
                Report(reportDirectory, desktopName, nested, exitCode, timedOut, leftovers);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("offstage: could not write the report to " + reportDirectory + ": " + e.Message);
            }
        }

        CloseHandle(process.hProcess);
        IntPtr ownJob = job;
        job = IntPtr.Zero;
        if (options.KeepOrphans && !timedOut)
        {
            // A process left running that is still starting up has not attached to the hidden desktop yet, and a desktop
            // that no one holds is gone once this process exits: the process then dies before its first line runs (seen
            // 2026-09-23, 4 of 5 kept processes, once this helper stopped waiting 100 ms at exit). Each one still in the job
            // gets a handle of its own to the desktop (the least access there is, inheritable, so a launcher's children
            // carry it too), which keeps the desktop alive for as long as it runs.
            if (hidden != IntPtr.Zero)
                foreach (uint pid in JobProcessIds(ownJob)) HandDesktopTo(pid, hidden, ownJob);
            SetJobLimits(ownJob, 0);
        }
        CloseHandle(ownJob);
        if (hidden != IntPtr.Zero) CloseDesktop(hidden);
        return exitCode;
    }

    // Starts the command suspended on the given desktop (null: this process's), handing it this process's standard
    // handles and nothing else.
    static PROCESS_INFORMATION Start(string commandLine, IntPtr desktop)
    {
        IntPtr self = GetCurrentProcess();
        int[] which = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
        IntPtr[] standard = new IntPtr[3];
        List<IntPtr> inheritable = new List<IntPtr>();
        for (int i = 0; i < 3; i++)
        {
            IntPtr handle = GetStdHandle(which[i]);
            IntPtr copy;
            if (handle != IntPtr.Zero && handle != INVALID_HANDLE_VALUE && DuplicateHandle(self, handle, self, out copy, 0, true, DUPLICATE_SAME_ACCESS))
            {
                standard[i] = copy;
                inheritable.Add(copy);
            }
        }
        STARTUPINFOEX startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        startup.StartupInfo.lpDesktop = desktop;
        uint flags = CREATE_SUSPENDED;
        IntPtr attributes = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        try
        {
            if (inheritable.Count > 0)
            {
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = standard[0];
                startup.StartupInfo.hStdOutput = standard[1];
                startup.StartupInfo.hStdError = standard[2];
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                attributes = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size))
                {
                    Marshal.FreeHGlobal(attributes);
                    attributes = IntPtr.Zero;
                    throw new Refusal(ExitFailed, "could not prepare the handle list: " + LastError());
                }
                handleList = Marshal.AllocHGlobal(IntPtr.Size * inheritable.Count);
                for (int i = 0; i < inheritable.Count; i++) Marshal.WriteIntPtr(handleList, i * IntPtr.Size, inheritable[i]);
                if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleList, (IntPtr)(IntPtr.Size * inheritable.Count), IntPtr.Zero, IntPtr.Zero))
                    throw new Refusal(ExitFailed, "could not set the handle list: " + LastError());
                startup.lpAttributeList = attributes;
                flags |= EXTENDED_STARTUPINFO_PRESENT;
            }
            StringBuilder line = new StringBuilder(commandLine, commandLine.Length + 1);
            PROCESS_INFORMATION process;
            if (!CreateProcessW(null, line, IntPtr.Zero, IntPtr.Zero, inheritable.Count > 0, flags, IntPtr.Zero, null, ref startup, out process))
            {
                int error = Marshal.GetLastWin32Error();
                bool missing = error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
                throw new Refusal(missing ? ExitNotFound : ExitCannotRun, "could not start " + commandLine + ": " + new Win32Exception(error).Message);
            }
            return process;
        }
        finally
        {
            if (attributes != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributes);
                Marshal.FreeHGlobal(attributes);
            }
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            foreach (IntPtr handle in inheritable) CloseHandle(handle);
        }
    }

    // Ctrl+C reaches a console command too, which usually stops on its own; whatever is still running 10 s later is
    // stopped. Closing the console stops everything at once.
    static bool OnConsoleControl(uint type)
    {
        IntPtr ownJob = job;
        if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                Thread.Sleep(10000);
                if (ownJob != IntPtr.Zero) TerminateJobObject(ownJob, ExitInterrupted);
            });
            return true;
        }
        if (ownJob != IntPtr.Zero) TerminateJobObject(ownJob, ExitInterrupted);
        return false;
    }

    static void WatchParent()
    {
        PROCESS_BASIC_INFORMATION basic = new PROCESS_BASIC_INFORMATION();
        int returned;
        if (NtQueryInformationProcess(GetCurrentProcess(), 0, ref basic, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returned) != 0) return;
        IntPtr parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)basic.InheritedFromUniqueProcessId.ToInt64());
        if (parent == IntPtr.Zero) return;
        // The id may already belong to a newer process: only a parent that started before this process counts.
        long parentStart, ownStart, unused;
        if (!GetProcessTimes(parent, out parentStart, out unused, out unused, out unused) ||
            !GetProcessTimes(GetCurrentProcess(), out ownStart, out unused, out unused, out unused) || parentStart > ownStart)
        {
            CloseHandle(parent);
            return;
        }
        Thread watch = new Thread(delegate ()
        {
            WaitForSingleObject(parent, INFINITE);
            IntPtr ownJob = job;
            if (ownJob != IntPtr.Zero) TerminateJobObject(ownJob, ExitInterrupted);
        });
        watch.IsBackground = true;
        watch.Start();
    }

    static bool NoteWindow(IntPtr window, IntPtr unused)
    {
        if (!IsWindowVisible(window)) return true;
        long key = window.ToInt64();
        lock (seen)
        {
            Window known;
            if (seen.TryGetValue(key, out known))
            {
                if (known.Title.Length == 0) known.Title = WindowText(window);
                return true;
            }
        }
        Window described = Describe(window);
        lock (seen) seen[key] = described;
        return true;
    }

    // The visible windows on the run's own desktop (an app launched with a desktop of its own is listed by its own helper).
    static string OpenWindows(IntPtr desktop, string name)
    {
        List<string> open = new List<string>();
        EnumDesktopWindows(desktop, delegate (IntPtr window, IntPtr unused)
        {
            if (IsWindowVisible(window))
            {
                Window w = Describe(window);
                open.Add(w.Process + " \"" + w.Title + "\" (" + w.ClassName + ")");
            }
            return true;
        }, IntPtr.Zero);
        return open.Count == 0
            ? "; no window was open on desktop " + name
            : "; open on desktop " + name + ": " + string.Join(", ", open.ToArray());
    }

    static Window Describe(IntPtr window)
    {
        Window w = new Window();
        w.Title = WindowText(window);
        StringBuilder name = new StringBuilder(256);
        GetClassNameW(window, name, name.Capacity);
        w.ClassName = name.ToString();
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        w.Process = ProcessName(pid);
        return w;
    }

    static string WindowText(IntPtr window)
    {
        StringBuilder text = new StringBuilder(512);
        InternalGetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    static string ProcessName(uint pid)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
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

    static void HandDesktopTo(uint pid, IntPtr desktop, IntPtr ownJob)
    {
        IntPtr target = OpenProcess(PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (target == IntPtr.Zero) return;
        bool inJob;
        // Only a process of this run: its id could have gone to another process since the list was read.
        if (IsProcessInJob(target, ownJob, out inJob) && inJob)
        {
            IntPtr copy;
            DuplicateHandle(GetCurrentProcess(), desktop, target, out copy, DESKTOP_READOBJECTS, true, 0);
        }
        CloseHandle(target);
    }

    static bool SetJobLimits(IntPtr ownJob, uint flags)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = flags;
        return SetInformationJobObject(ownJob, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
    }

    static List<uint> JobProcessIds(IntPtr ownJob)
    {
        List<uint> ids = new List<uint>();
        const int capacity = 1024;
        int size = 8 + IntPtr.Size * capacity;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(ownJob, JobObjectBasicProcessIdList, buffer, size, IntPtr.Zero)) return ids;
            int listed = Marshal.ReadInt32(buffer, 4);
            for (int i = 0; i < listed; i++) ids.Add((uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return ids;
    }

    static void Report(string directory, string desktopName, bool nested, int exitCode, bool timedOut, List<string> leftovers)
    {
        StringBuilder json = new StringBuilder();
        json.Append("{\"desktop\":").Append(Json(desktopName));
        json.Append(",\"nested\":").Append(nested ? "true" : "false");
        json.Append(",\"exitCode\":").Append(exitCode);
        json.Append(",\"timedOut\":").Append(timedOut ? "true" : "false");
        json.Append(",\"windows\":[");
        bool first = true;
        lock (seen)
        {
            foreach (Window w in seen.Values)
            {
                if (!first) json.Append(',');
                first = false;
                json.Append("{\"process\":").Append(Json(w.Process)).Append(",\"title\":").Append(Json(w.Title)).Append(",\"class\":").Append(Json(w.ClassName)).Append('}');
            }
        }
        json.Append("],\"leftovers\":[");
        for (int i = 0; i < leftovers.Count; i++) json.Append(i > 0 ? "," : "").Append(Json(leftovers[i]));
        json.Append("]}");
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "offstage-" + GetCurrentProcessId() + "-" + DateTime.UtcNow.Ticks + ".json"), json.ToString());
    }

    static string ParseOptions(string rest, Options options)
    {
        int i = 0;
        while (true)
        {
            while (i < rest.Length && (rest[i] == ' ' || rest[i] == '\t')) i++;
            if (i >= rest.Length)
                throw new Refusal(ExitFailed, "nothing to run. Usage: offstage [--timeout <seconds>] [--wait-all] [--keep-orphans] [--desktop <name> | --own-desktop] [--verbose] -- <command line>");
            int start = i;
            while (i < rest.Length && rest[i] != ' ' && rest[i] != '\t') i++;
            string token = rest.Substring(start, i - start);
            if (token == "--")
            {
                string tail = rest.Substring(i).TrimStart(' ', '\t');
                if (tail.Length == 0) throw new Refusal(ExitFailed, "nothing to run after --");
                if (options.OwnDesktop && options.Desktop.Length > 0)
                    throw new Refusal(ExitFailed, "--desktop and --own-desktop exclude each other");
                return tail;
            }
            if (token == "--wait-all") options.WaitAll = true;
            else if (token == "--keep-orphans") options.KeepOrphans = true;
            else if (token == "--verbose") options.Verbose = true;
            else if (token == "--own-desktop") options.OwnDesktop = true;
            else if (token == "--timeout" || token == "--desktop")
            {
                while (i < rest.Length && (rest[i] == ' ' || rest[i] == '\t')) i++;
                start = i;
                while (i < rest.Length && rest[i] != ' ' && rest[i] != '\t') i++;
                string value = rest.Substring(start, i - start);
                if (token == "--timeout") options.TimeoutSeconds = Seconds(value, "--timeout");
                else if (value.Length == 0 || value == "--") throw new Refusal(ExitFailed, "--desktop takes the name of a desktop");
                else options.Desktop = value;
            }
            else throw new Refusal(ExitFailed, "unknown option " + token + " (the command goes after --)");
        }
    }

    static int Seconds(string text, string name)
    {
        if (string.IsNullOrEmpty(text)) return 0;
        int seconds;
        if (!int.TryParse(text, out seconds) || seconds < 0 || seconds > 2000000)
            throw new Refusal(ExitFailed, name + " takes a whole number of seconds, not " + text);
        return seconds;
    }

    static bool IsOn(string value)
    {
        if (string.IsNullOrEmpty(value)) return false;
        string v = value.Trim().ToLowerInvariant();
        return v != "0" && v != "false" && v != "off" && v != "no";
    }

    // The rest of a command line after its program name, parsed the way the C runtime reads argv[0].
    static string AfterProgramName(string raw)
    {
        int i = 0;
        if (raw.Length > 0 && raw[0] == '"')
        {
            int close = raw.IndexOf('"', 1);
            i = close < 0 ? raw.Length : close + 1;
        }
        else
        {
            while (i < raw.Length && raw[i] != ' ' && raw[i] != '\t') i++;
        }
        return raw.Substring(i).TrimStart(' ', '\t');
    }

    // One argument, quoted for the C runtime's parser.
    static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return argument;
        StringBuilder quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in argument)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            quoted.Append('\\', c == '"' ? backslashes * 2 + 1 : backslashes);
            quoted.Append(c);
            backslashes = 0;
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    static string ObjectName(IntPtr handle)
    {
        int needed;
        GetUserObjectInformationW(handle, UOI_NAME, null, 0, out needed);
        StringBuilder name = new StringBuilder(needed / 2 + 1);
        return GetUserObjectInformationW(handle, UOI_NAME, name, name.Capacity * 2, out needed) ? name.ToString() : "";
    }

    static string Tally(List<string> names)
    {
        Dictionary<string, int> counts = new Dictionary<string, int>();
        List<string> order = new List<string>();
        foreach (string name in names)
        {
            if (!counts.ContainsKey(name))
            {
                counts[name] = 0;
                order.Add(name);
            }
            counts[name]++;
        }
        List<string> parts = new List<string>();
        foreach (string name in order) parts.Add(counts[name] > 1 ? name + " x" + counts[name] : name);
        return string.Join(", ", parts.ToArray());
    }

    static string Count(int n, string one, string many)
    {
        return n + " " + (n == 1 ? one : many);
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

    static string LastError()
    {
        return new Win32Exception(Marshal.GetLastWin32Error()).Message;
    }

    const uint GENERIC_ALL = 0x10000000;
    const int UOI_NAME = 2;
    const int STD_INPUT_HANDLE = -10;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_ERROR_HANDLE = -12;
    static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
    const uint DUPLICATE_SAME_ACCESS = 2;
    const uint CREATE_SUSPENDED = 0x4;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    const int STARTF_USESTDHANDLES = 0x100;
    const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectBasicProcessIdList = 3;
    const int JobObjectExtendedLimitInformation = 9;
    const uint INFINITE = 0xFFFFFFFF;
    const uint WAIT_TIMEOUT = 0x102;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint PROCESS_DUP_HANDLE = 0x40;
    const uint SYNCHRONIZE = 0x00100000;
    const uint DESKTOP_READOBJECTS = 0x1;
    const int ERROR_FILE_NOT_FOUND = 2;
    const int ERROR_PATH_NOT_FOUND = 3;
    const uint CTRL_C_EVENT = 0;
    const uint CTRL_BREAK_EVENT = 1;

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    delegate bool EnumWindowsProc(IntPtr window, IntPtr lParam);
    delegate bool ConsoleCtrlHandler(uint type);

    [DllImport("kernel32.dll")] static extern IntPtr GetCommandLineW();
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref PROCESS_BASIC_INFORMATION info, int length, out int returned);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, uint flags, uint access, IntPtr attributes);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);
    [DllImport("user32.dll", SetLastError = true)] static extern bool EnumDesktopWindows(IntPtr desktop, EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int InternalGetWindowText(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
}
`

const OFF = new Set(['0', 'false', 'off', 'no'])

/** True where offstage hides windows: on Windows, unless OFFSTAGE is 0, false, off or no. */
function enabled(env = process.env) {
  return (
    process.platform === 'win32' &&
    !OFF.has(
      String(env.OFFSTAGE ?? '')
        .trim()
        .toLowerCase(),
    )
  )
}

// Each distinct reason once: an early, unrelated warning must not hide a later one.
const warned = new Set()
function warnOnce(message, outcome = 'windows will show on screen') {
  if (warned.has(message)) return
  warned.add(message)
  process.stderr.write(`offstage: ${message}; ${outcome}\n`)
}

// What falling back to visible windows also drops, said once with the reason: without the helper there is no timeout and
// no waiting for the whole tree.
function fallbackOutcome(dropped) {
  const names = dropped.filter(Boolean)
  return names.length === 0
    ? undefined
    : `windows will show on screen, and ${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} not applied`
}

let helperFailure = null

/**
 * The helper's path, compiled on first use and cached by its source's hash: in OFFSTAGE_CACHE, or %LOCALAPPDATA%\offstage
 * (a folder only this user can write to, also when running as a service, unlike a shared temp folder). Throws when it
 * cannot be built or its first run fails, and again on every later call in this process.
 */
function helper() {
  if (helperFailure) throw helperFailure
  try {
    return buildHelper()
  } catch (error) {
    helperFailure = error
    throw error
  }
}

function buildHelper() {
  const hash = createHash('sha256').update(HELPER_SOURCE).digest('hex').slice(0, 12)
  const folder = process.env.OFFSTAGE_CACHE
    ? path.resolve(process.env.OFFSTAGE_CACHE)
    : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'offstage')
  const exe = path.join(folder, `offstage-${hash}.exe`)
  if (fs.existsSync(exe)) return exe
  fs.mkdirSync(folder, { recursive: true })
  // A unique name per build, renamed into place: parallel test workers may all build at once.
  const stem = path.join(folder, `offstage-${hash}-${process.pid}-${Date.now()}`)
  fs.writeFileSync(`${stem}.cs`, HELPER_SOURCE)
  try {
    const built = spawnSync(compiler(), ['-nologo', '-target:exe', '-optimize+', `-out:${stem}.exe`, `${stem}.cs`], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (built.status !== 0) {
      throw new Error(
        `could not compile the helper: ${built.error?.message ?? ''}${built.stdout ?? ''}${built.stderr ?? ''}`,
      )
    }
    // Windows can refuse to run a new unsigned program (Smart App Control, application control, an antivirus): run it
    // once before trusting it, so a refusal falls back to visible windows instead of failing every launch.
    const trial = spawnSync(`${stem}.exe`, ['--', process.env.ComSpec || 'cmd.exe', '/d', '/c', 'exit 0'], {
      windowsHide: true,
      timeout: 30_000,
    })
    if (trial.status !== 0) {
      throw new Error(`the helper was built but does not run (${trial.error?.code ?? `exit ${trial.status}`})`)
    }
    // Another process may have put its own build in place meanwhile (then that one is used), and an antivirus scanning
    // the new file can hold it for a moment: a few short retries before this process gives up on offstage.
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(`${stem}.exe`, exe)
        break
      } catch (error) {
        if (fs.existsSync(exe)) break
        if (attempt === 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
      }
    }
  } finally {
    // Best effort: a file another process still holds must not turn a good build, or a clear error, into a crash.
    for (const leftover of [`${stem}.cs`, `${stem}.exe`]) {
      try {
        fs.rmSync(leftover, { force: true })
      } catch {
        // Left behind, harmless: every build uses a name of its own.
      }
    }
  }
  return exe
}

function compiler() {
  const windows = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  for (const framework of ['Framework64', 'Framework']) {
    const csc = path.join(windows, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe')
    if (fs.existsSync(csc)) return csc
  }
  throw new Error(`the .NET Framework 4 C# compiler (csc.exe) is not under ${path.join(windows, 'Microsoft.NET')}`)
}

/**
 * Options for Playwright's `_electron.launch()` that start the app offstage: the helper stands in as the executable and
 * starts Electron on a hidden desktop, with Playwright's own loader in front as Playwright adds it itself (with an
 * `executablePath` of the caller's, as Playwright does, without it). Returns the options unchanged when offstage is off.
 */
function electronLaunchOptions(options = {}) {
  if (!enabled()) return options
  try {
    const cwd = options.cwd ?? process.cwd()
    let prepend = ''
    let target = options.executablePath
    if (!target) {
      const loader = playwrightElectronLoader(cwd)
      if (!loader)
        throw new Error("Playwright's Electron loader (playwright-core/lib/server/electron/loader.js) was not found")
      prepend = `-r ${quote(loader)}`
      // Playwright requires electron from its own playwright-core folder; resolve it from there first.
      target = electronBinary([path.resolve(loader, '..', '..', '..', '..'), cwd, __dirname])
    }
    return {
      ...options,
      executablePath: helper(),
      // OFFSTAGE_OWN_DESKTOP: every app launch gets a desktop, and so a focus, of its own, also inside a wrapped run.
      env: {
        ...(options.env ?? process.env),
        OFFSTAGE_EXEC: target,
        OFFSTAGE_EXEC_PREPEND: prepend,
        OFFSTAGE_OWN_DESKTOP: '1',
      },
    }
  } catch (error) {
    warnOnce(error.message)
    return options
  }
}

/**
 * `[command, args]` for child_process.spawn or execFile that run `file args` offstage; unchanged when offstage is off.
 * The spawned process stands for the program: it exits with the program's exit code, and killing it stops the whole tree.
 * What the program leaves running when it exits is stopped after a moment, unless `waitForAll` (wait for the whole tree:
 * an app that restarts itself or hands over to another process) or `keepOrphans` (leave it). `timeout` is in seconds.
 * The program gets a desktop of its own, also when this process runs offstage itself. `desktop` runs it on an app's
 * desktop instead (the app's OFFSTAGE_DESKTOP): a helper that touches the app's windows by handle (window messages, UI
 * Automation) must share their desktop, where the handle is valid.
 * Only stdin, stdout and stderr reach the program (no IPC channel, no --remote-debugging-pipe). The helper is a console
 * program: spawn it with `windowsHide: true` if the calling process may have no console of its own (a GUI tool).
 * `file` is a program (.exe). A .cmd or .bat is refused and returned unchanged: run those through the command-line
 * wrapper, which escapes for cmd.exe. When the helper cannot run, the program starts as is, without timeout or waitForAll.
 */
function spawnArgs(file, args = [], { waitForAll = false, keepOrphans = false, timeout = 0, desktop = '' } = {}) {
  // A wrong desktop is the caller's mistake, never a reason to fall back: a helper on another desktop reads wrong answers.
  if (desktop && !/^[\w.-]+$/.test(desktop))
    throw new TypeError(`desktop takes a desktop's name, not ${JSON.stringify(desktop)}`)
  if (!enabled()) return [file, [...args]]
  if (/\.(cmd|bat)$/i.test(file)) {
    warnOnce(
      `spawnArgs runs programs, not ${path.basename(file)}`,
      'it is returned unchanged (run it through the CLI instead)',
    )
    return [file, [...args]]
  }
  try {
    if (!Number.isInteger(timeout) || timeout < 0)
      throw new Error(`timeout takes a whole number of seconds, not ${timeout}`)
    const flags = [
      ...(timeout ? ['--timeout', String(timeout)] : []),
      ...(waitForAll ? ['--wait-all'] : []),
      ...(keepOrphans ? ['--keep-orphans'] : []),
      ...(desktop ? ['--desktop', desktop] : ['--own-desktop']),
    ]
    return [helper(), [...flags, '--', file, ...args]]
  } catch (error) {
    warnOnce(error.message, fallbackOutcome([timeout && 'timeout', waitForAll && 'waitForAll']))
    return [file, [...args]]
  }
}

// The electron package's main export is the path of its binary.
function electronBinary(paths) {
  return require(require.resolve('electron', { paths }))
}

// The loader Playwright puts in front of Electron's arguments when it resolves Electron itself. The copy of Playwright
// already loaded in this process is the one that will launch; otherwise it is found from the project.
function playwrightElectronLoader(cwd) {
  const loaderOf = (root) => path.join(root, 'lib', 'server', 'electron', 'loader.js')
  for (const file of Object.keys(require.cache)) {
    const root = /^(.*[\\/]playwright-core)[\\/]lib[\\/]/.exec(file)?.[1]
    if (root && fs.existsSync(loaderOf(root))) return loaderOf(root)
  }
  for (const chain of [
    ['@playwright/test', 'playwright', 'playwright-core'],
    ['playwright', 'playwright-core'],
    ['playwright-core'],
  ]) {
    try {
      let folder = cwd
      for (const name of chain) folder = path.dirname(require.resolve(`${name}/package.json`, { paths: [folder] }))
      if (fs.existsSync(loaderOf(folder))) return loaderOf(folder)
    } catch {
      // Not installed along this chain; try the next.
    }
  }
  return null
}

// One argument, quoted for the C runtime's parser (how Windows programs split their command line).
function quote(argument) {
  return argument !== '' && !/[\s"]/.test(argument) ? argument : quoted(argument)
}

// One argument in quotes, by the C runtime's rules: the backslashes before a quote, and before the closing quote, are
// doubled and the quote is escaped; every other backslash stays as it is.
function quoted(argument) {
  let text = '"'
  let backslashes = 0
  for (const c of argument) {
    if (c === '\\') {
      backslashes++
      continue
    }
    text += '\\'.repeat(c === '"' ? backslashes * 2 + 1 : backslashes) + c
    backslashes = 0
  }
  return `${text}${'\\'.repeat(backslashes * 2)}"`
}

// Windows resolution for the command-line wrapper, as cross-spawn does it: an .exe or .com runs directly; anything else
// (.cmd shims, .bat) runs through cmd.exe with its metacharacters escaped, twice for node_modules/.bin shims, which hand
// their arguments to cmd.exe a second time. The metacharacters and the rule for shims follow cross-spawn
// (lib/util/escape.js), Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>, MIT License; the quoting inside is
// quoted() above, since cross-spawn's regular expressions mishandle two or more backslashes before a quote.
const CMD_METACHARACTERS = /([()\][%!^"`<>&|;, *?])/g

function findExecutable(command, cwd) {
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const suffixes = path.extname(command) ? ['', ...extensions] : extensions
  // A PATH entry may carry quotes ("C:\Program Files\Tool"), as cmd.exe accepts.
  const folders = /[\\/]/.test(command)
    ? ['']
    : [cwd, ...(process.env.PATH || '').split(path.delimiter).map((entry) => entry.replace(/^"(.*)"$/, '$1'))]
  for (const folder of folders.filter((entry, index) => index === 0 || entry)) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(cwd, folder, command + suffix)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // An App Execution Alias (Store Python, winget, wt) cannot be stat'ed, only lstat'ed; cmd.exe runs it all the same.
        try {
          const link = fs.lstatSync(candidate)
          if (link.isFile() || link.isSymbolicLink()) return candidate
        } catch {
          // Not here.
        }
      }
    }
  }
  return null
}

function cmdArgument(argument, twice) {
  const escaped = quoted(argument).replace(CMD_METACHARACTERS, '^$1')
  return twice ? escaped.replace(CMD_METACHARACTERS, '^$1') : escaped
}

// cmd.exe's own commands, which no search finds on disk.
const CMD_BUILTINS = new Set(
  'assoc break call cd chdir cls color copy date del dir echo endlocal erase exit for ftype goto if md mkdir mklink move path pause popd prompt pushd rd ren rename rmdir set setlocal shift start time title type ver verify vol'.split(
    ' ',
  ),
)

// How the wrapper starts `command args` on Windows: a program the helper runs directly, cmd.exe with one line, or
// nothing when the command is found neither on disk (the current folder, then PATH, as cmd.exe looks) nor in cmd.exe.
function windowsInvocation(command, args, cwd) {
  const file = findExecutable(command, cwd)
  if (file && /\.(com|exe)$/i.test(file)) return { file, args }
  if (!file && !CMD_BUILTINS.has(command.toLowerCase())) return { missing: true }
  const twice = Boolean(file) && /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file)
  const line = [
    path.normalize(command).replace(CMD_METACHARACTERS, '^$1'),
    ...args.map((a) => cmdArgument(a, twice)),
  ].join(' ')
  return { shell: process.env.ComSpec || 'cmd.exe', line: `/d /s /c "${line}"` }
}

const USAGE = `Usage: offstage-windows [--timeout <seconds>] [--wait-all] [--keep-orphans] [--verbose] [--] <command> [args...]
       offstage-windows --check
(npx offstage-windows ..., or node offstage.cjs ... when the file is copied into a project)
Runs the command on a hidden desktop (Windows) and exits with its exit code; elsewhere, or with OFFSTAGE=0, runs it as is.
Exit codes of its own: 124 timed out, 125 offstage failed, 126 could not start, 127 not found.`

function main(argv) {
  const options = { timeout: '', waitAll: false, keepOrphans: false, verbose: false }
  let index = 0
  for (; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--') {
      index++
      break
    }
    if (argument === '--wait-all') options.waitAll = true
    else if (argument === '--keep-orphans') options.keepOrphans = true
    else if (argument === '--verbose') options.verbose = true
    else if (argument === '--timeout') options.timeout = argv[++index] ?? ''
    else if (argument === '--check') return check()
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${USAGE}\n`)
      return Promise.resolve(0)
    } else if (argument.startsWith('--')) {
      process.stderr.write(`offstage: unknown option ${argument}\n${USAGE}\n`)
      return Promise.resolve(125)
    } else break
  }
  const [command, ...args] = argv.slice(index)
  if (!command) {
    process.stderr.write(`offstage: nothing to run\n${USAGE}\n`)
    return Promise.resolve(125)
  }
  if (options.timeout && !/^\d+$/.test(options.timeout)) {
    process.stderr.write(`offstage: --timeout takes a whole number of seconds, not ${options.timeout}\n`)
    return Promise.resolve(125)
  }
  const cwd = process.cwd()
  let exe = null
  if (enabled()) {
    try {
      exe = helper()
    } catch (error) {
      warnOnce(error.message, fallbackOutcome([options.timeout && '--timeout', options.waitAll && '--wait-all']))
    }
  }
  if (process.platform !== 'win32') return run(command, args, {})
  const invocation = windowsInvocation(command, args, cwd)
  if (invocation.missing) {
    process.stderr.write(`offstage: ${command} was not found in the current folder or on PATH\n`)
    return Promise.resolve(127)
  }
  if (!exe) {
    return invocation.file
      ? run(invocation.file, invocation.args, {})
      : run(invocation.shell, [invocation.line], { windowsVerbatimArguments: true })
  }
  // A browser opened from the hidden desktop could not be seen (and a browser the user starts meanwhile would join it
  // there), so Playwright's HTML report is not opened automatically unless the caller asks for it.
  const env =
    process.env.PLAYWRIGHT_HTML_OPEN || process.env.PW_TEST_HTML_REPORT_OPEN
      ? process.env
      : { ...process.env, PLAYWRIGHT_HTML_OPEN: 'never' }
  if (invocation.file) {
    const flags = [
      ...(options.timeout ? ['--timeout', options.timeout] : []),
      ...(options.waitAll ? ['--wait-all'] : []),
      ...(options.keepOrphans ? ['--keep-orphans'] : []),
      ...(options.verbose ? ['--verbose'] : []),
    ]
    return run(exe, [...flags, '--', invocation.file, ...invocation.args], { env })
  }
  // A cmd.exe line is passed through the environment: it must reach cmd.exe exactly as escaped, with no second quoting.
  return run(exe, [], {
    env: {
      ...env,
      OFFSTAGE_EXEC: invocation.shell,
      OFFSTAGE_EXEC_PREPEND: invocation.line,
      OFFSTAGE_TIMEOUT: options.timeout,
      OFFSTAGE_WAIT_ALL: options.waitAll ? '1' : '',
      OFFSTAGE_KEEP_ORPHANS: options.keepOrphans ? '1' : '',
      ...(options.verbose ? { OFFSTAGE_VERBOSE: '1' } : {}),
    },
  })
}

// Ctrl+C reaches the command itself; the wrapper waits for it to finish. A SIGTERM or SIGHUP sent to the wrapper alone is
// passed on (macOS and Linux; on Windows, ending the wrapper ends the helper, which ends the tree).
const ignore = () => {}

function run(file, args, extra) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'inherit', ...extra })
    const forward = (signal) => {
      try {
        child.kill(signal)
      } catch {
        // Already gone.
      }
    }
    const cleanup = () => {
      process.off('SIGINT', ignore)
      process.off('SIGTERM', forward)
      process.off('SIGHUP', forward)
    }
    process.on('SIGINT', ignore)
    process.on('SIGTERM', forward)
    process.on('SIGHUP', forward)
    child.on('error', (error) => {
      cleanup()
      process.stderr.write(`offstage: could not start ${file}: ${error.message}\n`)
      resolve(error.code === 'ENOENT' ? 127 : 126)
    })
    child.on('exit', (code, signal) => {
      cleanup()
      resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1))
    })
  })
}

function check() {
  if (process.platform !== 'win32') {
    process.stdout.write('offstage: not Windows, so commands run as they are\n')
    return Promise.resolve(0)
  }
  if (!enabled()) {
    process.stdout.write('offstage: turned off by OFFSTAGE, so windows show\n')
    return Promise.resolve(0)
  }
  let exe
  try {
    exe = helper()
  } catch (error) {
    process.stdout.write(`offstage is broken: ${error.message}\n`)
    return Promise.resolve(1)
  }
  const probe = spawnSync(exe, ['--', process.env.ComSpec || 'cmd.exe', '/d', '/c', 'echo %OFFSTAGE_DESKTOP%'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const desktop = (probe.stdout ?? '').trim()
  const works = probe.status === 0 && desktop.startsWith('offstage-')
  process.stdout.write(
    works
      ? `offstage works: helper ${exe}, a test command ran on desktop ${desktop}\n`
      : `offstage is broken: helper ${exe} exited ${probe.status}: ${probe.stdout ?? ''}${probe.stderr ?? ''}\n`,
  )
  return Promise.resolve(works ? 0 : 1)
}

exports.enabled = enabled
exports.helper = helper
exports.electronLaunchOptions = electronLaunchOptions
exports.spawnArgs = spawnArgs

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
