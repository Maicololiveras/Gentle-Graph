# One private Windows job per Pi invocation. The controller sends a PID only
# while that process is waiting for its start message over IPC.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class BenchJob {
    [StructLayout(LayoutKind.Sequential)]
    struct Basic {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Extended {
        public Basic Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Attach(int pid) {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        try {
            var info = new Extended();
            info.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)))) throw new Win32Exception();
            var process = OpenProcess(0x101, false, pid); // SET_QUOTA | TERMINATE
            if (process == IntPtr.Zero) throw new Win32Exception();
            try { if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(); }
            finally { CloseHandle(process); }
            return job;
        } catch { CloseHandle(job); throw; }
    }
}
'@
[Console]::WriteLine('ready')
$job = [IntPtr]::Zero
try {
    while ($null -ne ($line = [Console]::ReadLine())) {
        if ($line -eq 'release') {
            if ($job -eq [IntPtr]::Zero) { throw 'No active benchmark job' }
            [void][BenchJob]::CloseHandle($job)
            $job = [IntPtr]::Zero
        } else {
            if ($job -ne [IntPtr]::Zero) { throw 'Previous benchmark job still active' }
            $job = [BenchJob]::Attach([int]$line)
        }
        [Console]::WriteLine('ok')
    }
} finally {
    if ($job -ne [IntPtr]::Zero) { [void][BenchJob]::CloseHandle($job) }
}
