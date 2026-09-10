<#
.SYNOPSIS
    Read-only compatibility probe for Magic Home / Zengge Wi-Fi LED controllers.

.DESCRIPTION
    Determines whether a controller can be driven by the RGBeAll SignalRGB plugin, without
    changing anything on the device.

    This script only READS. It never sets a colour, never changes power state, and never
    writes device configuration.

.PARAMETER Ip
    IP address of the controller to probe.

.PARAMETER Discover
    Broadcast on UDP 48899 to find controllers on the local network, instead of probing one.

    Note: the discovery string is also the handshake that places these Wi-Fi modules into AT
    command mode on that socket. That is how every tool in this ecosystem discovers devices and
    it is harmless in normal use, but it is a state change rather than a pure read.

.PARAMETER Latency
    Run a round-trip latency benchmark using repeated read-only state queries.

.EXAMPLE
    .\rgbeall-probe.ps1 -Discover

.EXAMPLE
    .\rgbeall-probe.ps1 -Ip 192.0.2.50 -Latency
#>

[CmdletBinding(DefaultParameterSetName = 'Probe')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Probe', Position = 0)]
    [ValidatePattern('^\d{1,3}(\.\d{1,3}){3}$')]
    [string]$Ip,

    [Parameter(ParameterSetName = 'Probe')]
    [switch]$Latency,

    [Parameter(Mandatory = $true, ParameterSetName = 'Discover')]
    [switch]$Discover
)

$ErrorActionPreference = 'Stop'

$CONTROL_PORT   = 5577
$DISCOVERY_PORT = 48899
$DISCOVERY_MAGIC = 'HF-A11ASSISTHREAD'

function New-Frame([byte[]]$Bytes) {
    $sum = 0
    foreach ($b in $Bytes) { $sum += $b }
    return $Bytes + [byte]($sum -band 0xFF)
}
function ConvertTo-HexString([byte[]]$Bytes) {
    return (($Bytes | ForEach-Object { $_.ToString('X2') }) -join ' ')
}

# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------
function Invoke-Discovery {
    Write-Host ""
    Write-Host "Broadcasting discovery on UDP $DISCOVERY_PORT ..." -ForegroundColor Cyan

    $udp = New-Object System.Net.Sockets.UdpClient
    $seen = @{}
    $found = New-Object System.Collections.ArrayList
    try {
        $udp.EnableBroadcast = $true
        $udp.Client.ReceiveTimeout = 1500
        $payload = [System.Text.Encoding]::ASCII.GetBytes($DISCOVERY_MAGIC)
        $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Broadcast, $DISCOVERY_PORT)
        [void]$udp.Send($payload, $payload.Length, $ep)

        # Collect until the socket goes quiet. A receive timeout means "no more replies",
        # which is the normal exit - anything else is a real fault worth surfacing.
        $deadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $deadline) {
            $data = $null
            try {
                $remote = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
                $data = $udp.Receive([ref]$remote)
            } catch [System.Net.Sockets.SocketException] {
                break   # receive timeout: nothing further is coming
            } catch {
                Write-Verbose "Discovery receive failed: $($_.Exception.Message)"
                break
            }

            if ($null -eq $data -or $data.Length -eq 0) { continue }

            $text = ([System.Text.Encoding]::ASCII.GetString($data)).Trim()
            if ($text -match '^(\d{1,3}(?:\.\d{1,3}){3}),([0-9A-Fa-f]{12}),(.+)$') {
                $ipAddr = $Matches[1]
                if (-not $seen.ContainsKey($ipAddr)) {
                    $seen[$ipAddr] = $true
                    [void]$found.Add([pscustomobject]@{
                        IP = $ipAddr; MAC = $Matches[2].ToUpper(); Model = $Matches[3]
                    })
                }
            }
        }
    } finally {
        $udp.Close()
    }

    if ($found.Count -eq 0) {
        Write-Host "No controllers answered." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Broadcast discovery fails on many normal networks (client isolation, separate"
        Write-Host "VLANs, firewall). If you know the controller's IP, probe it directly:"
        Write-Host "    .\rgbeall-probe.ps1 -Ip <address>"
        return
    }

    Write-Host "Found $($found.Count) controller(s):" -ForegroundColor Green
    $found | Format-Table -AutoSize
    Write-Host "Probe one with:  .\rgbeall-probe.ps1 -Ip <address>"
}

# ---------------------------------------------------------------------------
# Probe
# ---------------------------------------------------------------------------
function Invoke-Probe {
    param([string]$Target)

    Write-Host ""
    Write-Host "Probing $Target" -ForegroundColor Cyan
    Write-Host ("-" * 58)

    # -- reachability --------------------------------------------------------
    $reachable = Test-Connection -ComputerName $Target -Count 2 -Quiet -ErrorAction SilentlyContinue
    Write-Host ("  ICMP reachable      : {0}" -f $(if ($reachable) { 'yes' } else { 'no (may be firewalled; not fatal)' }))

    # -- control port --------------------------------------------------------
    $client = New-Object System.Net.Sockets.TcpClient
    $open = $false
    try {
        $iar = $client.BeginConnect($Target, $CONTROL_PORT, $null, $null)
        $open = $iar.AsyncWaitHandle.WaitOne(4000, $false) -and $client.Connected
        if ($open) { $client.EndConnect($iar) }
    } catch { $open = $false }

    Write-Host ("  TCP {0}            : {1}" -f $CONTROL_PORT, $(if ($open) { 'OPEN' } else { 'CLOSED / FILTERED' }))

    if (-not $open) {
        try { $client.Close() } catch { }
        Write-Host ""
        Write-Host "NOT COMPATIBLE - the legacy control port is not reachable." -ForegroundColor Red
        Write-Host "Either the address is wrong, a firewall is blocking it, or this is a newer"
        Write-Host "model that does not expose the legacy protocol."
        return
    }

    $client.NoDelay = $true
    $client.ReceiveTimeout = 4000
    $client.SendTimeout = 4000
    $stream = $client.GetStream()

    # -- state query ---------------------------------------------------------
    # Drain first: any pending bytes would shift the response and produce
    # plausible-looking nonsense. See docs/PROTOCOL.md.
    Start-Sleep -Milliseconds 200
    while ($client.Available -gt 0) {
        $junk = New-Object byte[] $client.Available
        [void]$stream.Read($junk, 0, $junk.Length)
        Start-Sleep -Milliseconds 80
    }

    $query = New-Frame @(0x81, 0x8A, 0x8B)
    $stream.Write($query, 0, $query.Length)
    $stream.Flush()
    Start-Sleep -Milliseconds 400

    $buf = New-Object byte[] 14
    $got = 0
    while ($got -lt 14) {
        $n = $stream.Read($buf, $got, 14 - $got)
        if ($n -le 0) { break }
        $got += $n
    }

    if ($got -lt 14 -or $buf[0] -ne 0x81) {
        Write-Host ("  State query         : FAILED (got {0} bytes, header 0x{1:X2})" -f $got, $buf[0]) -ForegroundColor Red
        Write-Host ""
        Write-Host "NOT COMPATIBLE - the controller did not answer in plaintext." -ForegroundColor Red
        Write-Host "This is almost certainly a newer unit using the encrypted local API."
        $stream.Close(); $client.Close()
        return
    }

    Write-Host ("  State query         : OK   [{0}]" -f (ConvertTo-HexString $buf))
    Write-Host ""

    $deviceType = $buf[1]
    $powerOn    = ($buf[2] -eq 0x23)
    $mode       = $buf[3]
    $colourMode = $buf[12]

    Write-Host ("  Device type         : 0x{0:X2}" -f $deviceType)
    Write-Host ("  Power               : {0}" -f $(if ($powerOn) { 'ON' } else { 'OFF' }))
    Write-Host ("  Mode                : 0x{0:X2}{1}" -f $mode, $(if ($mode -eq 0x61) { ' (static colour)' } else { ' (built-in effect)' }))
    Write-Host ("  Current colour      : R={0} G={1} B={2}" -f $buf[6], $buf[7], $buf[8])
    Write-Host ("  Colour mode         : 0x{0:X2}" -f $colourMode)

    # -- firmware over UDP ---------------------------------------------------
    $firmware = Get-FirmwareVersion -Target $Target
    if ($firmware) { Write-Host ("  Firmware            : {0}" -f $firmware) }

    # -- latency -------------------------------------------------------------
    if ($Latency) {
        Write-Host ""
        Write-Host "  Latency (20 read-only queries):"
        $times = @()
        $rbuf = New-Object byte[] 32
        for ($i = 0; $i -lt 20; $i++) {
            while ($client.Available -gt 0) { [void]$stream.Read($rbuf, 0, [Math]::Min($client.Available, 32)) }
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $stream.Write($query, 0, $query.Length); $stream.Flush()
            [void]$stream.Read($rbuf, 0, 14)
            $sw.Stop()
            $times += $sw.Elapsed.TotalMilliseconds
        }
        $m = $times | Measure-Object -Average -Minimum -Maximum
        Write-Host ("    min {0:N1} ms | avg {1:N1} ms | max {2:N1} ms" -f $m.Minimum, $m.Average, $m.Maximum)
    }

    $stream.Close(); $client.Close()

    # -- verdict -------------------------------------------------------------
    Write-Host ""
    Write-Host ("-" * 58)

    $analog = ($deviceType -eq 0x33) -or ($colourMode -eq 0xF0)

    if ($deviceType -eq 0xA3) {
        Write-Host "NOT SUPPORTED - this is an ADDRESSABLE (0xA3) controller." -ForegroundColor Yellow
        Write-Host "It speaks a different protocol. This plugin targets analog controllers only."
    } elseif ($analog) {
        Write-Host "COMPATIBLE - analog RGB controller on the legacy protocol." -ForegroundColor Green
        Write-Host ""
        Write-Host "Remember: analog controllers have ONE colour zone. The whole strip is always"
        Write-Host "a single colour - per-LED effects are not possible on this hardware."
    } else {
        Write-Host "LIKELY COMPATIBLE - answered the legacy protocol, but reports an" -ForegroundColor Yellow
        Write-Host ("unrecognised device type (0x{0:X2}). Worth trying; please report the result." -f $deviceType)
    }
}

function Get-FirmwareVersion {
    param([string]$Target)

    $udp = New-Object System.Net.Sockets.UdpClient
    try {
        $udp.Client.ReceiveTimeout = 2500
        $udp.Connect($Target, $DISCOVERY_PORT)

        # The module needs the discovery handshake before it accepts AT commands.
        $hello = [System.Text.Encoding]::ASCII.GetBytes($DISCOVERY_MAGIC)
        [void]$udp.Send($hello, $hello.Length)
        $remote = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
        [void]$udp.Receive([ref]$remote)

        $cmd = [System.Text.Encoding]::ASCII.GetBytes("AT+LVER`r")
        [void]$udp.Send($cmd, $cmd.Length)
        $resp = $udp.Receive([ref]$remote)
        $text = ([System.Text.Encoding]::ASCII.GetString($resp)).Trim()
        return ($text -replace '^\+ok=', '')
    } catch {
        return $null
    } finally {
        $udp.Close()
    }
}

# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "Magic Home controller probe (read-only)" -ForegroundColor White

if ($Discover) {
    Invoke-Discovery
} else {
    Invoke-Probe -Target $Ip
}
Write-Host ""
