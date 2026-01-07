let ffmpeg;
let ffmpegLoadingPromise;
let activeJobId = null;
let logBuffer = [];
let lastLogTime = 0;
let estimatedDuration = 0;
let lastProgressSent = 0;

const ensureDomShim = () => {
    if (typeof document === 'undefined') {
        const headStub = { appendChild: () => {} };
        const scriptStub = { addEventListener: () => {}, removeEventListener: () => {} };
        self.document = {
            baseURI: self.location.href,
            currentScript: null,
            createElement: () => ({ ...scriptStub }),
            getElementsByTagName: () => [headStub],
            querySelector: () => null
        };
    }
    if (typeof window === 'undefined') {
        self.window = self;
    }
    if (typeof navigator === 'undefined') {
        self.navigator = { userAgent: 'worker' };
    }
};

ensureDomShim();
var document = self.document;
var window = self.window;
var navigator = self.navigator;

const FFMPEG_URL = './ffmpeg.min.js?v=1';
const CORE_URL = 'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js';
const MAX_LOG_LINES = 200;

const send = (payload, transfer) => {
    if (transfer) {
        self.postMessage(payload, transfer);
    } else {
        self.postMessage(payload);
    }
};

const pushLog = (message) => {
    logBuffer.push(message);
    if (logBuffer.length > MAX_LOG_LINES) {
        logBuffer = logBuffer.slice(-MAX_LOG_LINES);
    }
};

const cleanLog = (message) => message.replace(/\s+/g, ' ').trim();

// Parse time string like "00:00:05.23" or "00:05.23" to seconds
const parseTimeToSeconds = (timeStr) => {
    if (!timeStr) return 0;
    const parts = timeStr.split(':').map(p => parseFloat(p) || 0);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }
    return parts[0] || 0;
};

// Extract duration from FFmpeg output (e.g., "Duration: 00:00:10.50")
const parseDuration = (message) => {
    const match = message.match(/Duration:\s*(\d{2}:\d{2}:\d{2}\.\d+)/i);
    if (match) {
        return parseTimeToSeconds(match[1]);
    }
    return 0;
};

// Extract current time from FFmpeg progress output (e.g., "time=00:00:05.23")
const parseCurrentTime = (message) => {
    const match = message.match(/time=\s*(\d{2}:\d{2}:\d{2}\.\d+)/i);
    if (match) {
        return parseTimeToSeconds(match[1]);
    }
    // Also try simpler format
    const simpleMatch = message.match(/time=\s*(\d+:\d+\.\d+)/i);
    if (simpleMatch) {
        return parseTimeToSeconds(simpleMatch[1]);
    }
    return 0;
};

const runCommand = async (ffmpegInstance, args) => {
    try {
        await ffmpegInstance.run(...args);
    } catch (error) {
        const message = error?.message || String(error);
        if (!message.includes('exit(0)')) {
            throw error;
        }
    }
};

const ensureFFmpeg = async () => {
    if (!self.FFmpeg) {
        send({ type: 'status', jobId: activeJobId, message: 'Loading FFmpeg library...' });
        try {
            importScripts(FFMPEG_URL);
        } catch (error) {
            throw new Error(`FFmpeg wrapper failed to load (${error?.message || error}).`);
        }
    }
    const { createFFmpeg } = self.FFmpeg || {};
    if (!createFFmpeg) {
        throw new Error('FFmpeg library failed to load.');
    }
    if (!ffmpeg) {
        ffmpeg = createFFmpeg({
            log: true,
            mainName: 'main',
            corePath: CORE_URL
        });
        if (ffmpeg.setLogger) {
            ffmpeg.setLogger(({ type, message }) => {
                if (typeof message !== 'string') return;
                pushLog(message);
                const now = Date.now();
                const trimmed = cleanLog(message);
                
                // Try to extract duration from input file info
                if (trimmed.includes('Duration:') && estimatedDuration === 0) {
                    const duration = parseDuration(trimmed);
                    if (duration > 0) {
                        estimatedDuration = duration;
                    }
                }
                
                // Calculate progress from current time
                if (trimmed.includes('time=') && estimatedDuration > 0) {
                    const currentTime = parseCurrentTime(trimmed);
                    if (currentTime > 0) {
                        const percent = Math.min(95, Math.max(0, Math.round((currentTime / estimatedDuration) * 100)));
                        // Only send if progress increased
                        if (percent > lastProgressSent) {
                            lastProgressSent = percent;
                            send({ type: 'progress', jobId: activeJobId, progress: percent });
                        }
                    }
                }
                
                if (trimmed.includes('frame=') || trimmed.includes('time=')) {
                    if (now - lastLogTime > 160) {
                        lastLogTime = now;
                        send({ type: 'log', jobId: activeJobId, line: trimmed });
                    }
                }
                if (type === 'error' && trimmed) {
                    send({ type: 'log', jobId: activeJobId, line: trimmed });
                }
            });
        }
        // Keep setProgress as fallback, but our logger-based progress is more reliable
        if (ffmpeg.setProgress) {
            ffmpeg.setProgress(({ ratio }) => {
                // Only use this if our time-based calculation hasn't sent any progress
                if (lastProgressSent === 0 && ratio && Number.isFinite(ratio)) {
                    const percent = Math.min(95, Math.max(0, Math.round(ratio * 100)));
                    if (percent > 0) {
                        send({ type: 'progress', jobId: activeJobId, progress: percent });
                    }
                }
            });
        }
        ffmpegLoadingPromise = ffmpeg.load();
    }
    if (ffmpegLoadingPromise) {
        send({ type: 'status', jobId: activeJobId, message: 'Loading FFmpeg engine (first run can take ~10s)...' });
        await ffmpegLoadingPromise;
        ffmpegLoadingPromise = null;
    }
    return ffmpeg;
};

self.onmessage = async (event) => {
    const { type, payload } = event.data || {};
    if (type !== 'convert') return;
    const { jobId, buffer, targetFormat, options } = payload || {};
    activeJobId = jobId;
    if (!buffer) {
        send({ type: 'error', jobId, message: 'Missing input buffer.' });
        return;
    }

    const inputName = 'input.webm';
    const outputName = targetFormat === 'gif' ? 'output.gif' : 'output.mp4';
    const fps = (options && options.fps) || 30;
    const qualityProfile = (options && options.qualityProfile) || {};
    const scale = qualityProfile.gifScale || '640:-1';
    const preset = (qualityProfile.mp4 && qualityProfile.mp4.preset) || 'veryfast';
    const crf = (qualityProfile.mp4 && qualityProfile.mp4.crf) || '23';

    logBuffer = [];
    lastLogTime = 0;
    estimatedDuration = 0;
    lastProgressSent = 0;
    try {
        send({ type: 'status', jobId, message: targetFormat === 'gif' ? 'Rendering GIF frames...' : 'Transcoding video...' });
        const ffmpegInstance = await ensureFFmpeg();
        try { ffmpegInstance.FS('unlink', inputName); } catch (_) {}
        try { ffmpegInstance.FS('unlink', outputName); } catch (_) {}
        ffmpegInstance.FS('writeFile', inputName, new Uint8Array(buffer));

        if (targetFormat === 'gif') {
            await runCommand(ffmpegInstance, [
                '-i', inputName,
                '-vf', 'fps=' + fps + ',scale=' + scale + ':flags=lanczos',
                '-loop', '0',
                outputName
            ]);
        } else {
            await runCommand(ffmpegInstance, [
                '-i', inputName,
                '-r', String(fps),
                '-c:v', 'libx264',
                '-preset', preset,
                '-crf', crf,
                '-c:a', 'aac',
                '-movflags', 'faststart',
                outputName
            ]);
        }

        const data = ffmpegInstance.FS('readFile', outputName);
        try { ffmpegInstance.FS('unlink', inputName); } catch (_) {}
        try { ffmpegInstance.FS('unlink', outputName); } catch (_) {}
        const outputBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        send({ type: 'done', jobId, buffer: outputBuffer, mimeType: targetFormat === 'gif' ? 'image/gif' : 'video/mp4' }, [outputBuffer]);
    } catch (error) {
        const logTail = logBuffer.slice(-12).join('\n');
        send({ type: 'error', jobId, message: error?.message || String(error), log: logTail });
    }
};
