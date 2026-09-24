<?php
/**
 * storage.php — хранилище пресетов в JSON-файлах + валидация.
 * storage.php — JSON-file preset storage + validation.
 *
 * Заводские пресеты: /presets/*.json (только чтение, "factory": true)
 * Пользовательские:  /presets/user/*.json (запись с блокировкой flock)
 * Factory presets: /presets/*.json (read-only); user presets: /presets/user/*.json (flock-protected writes)
 */
declare(strict_types=1);

final class ValidationException extends RuntimeException {}
final class NotFoundException extends RuntimeException {}
final class ForbiddenException extends RuntimeException {}

final class PresetValidator
{
    public const TYPES = ['bell', 'lowshelf', 'highshelf', 'lowcut', 'highcut', 'notch', 'bandpass', 'tiltshelf', 'flattilt'];
    public const SLOPES = [6, 12, 18, 24, 30, 36, 48, 72, 96];
    public const PLACEMENTS = ['stereo', 'left', 'right', 'mid', 'side'];
    public const MODES = ['zero', 'natural', 'linear'];
    public const MAX_BANDS = 24;

    /** Проверяет и нормализует пресет; бросает ValidationException. Validates and normalises. */
    public static function clean(array $in): array
    {
        $errors = [];
        $name = isset($in['name']) && is_string($in['name']) ? trim($in['name']) : '';
        if ($name === '' || mb_strlen($name) > 64) {
            $errors[] = 'name: required, 1–64 chars';
        }
        $eq = $in['eq'] ?? null;
        if (!is_array($eq) || !isset($eq['bands']) || !is_array($eq['bands'])) {
            $errors[] = 'eq.bands: array required';
            throw new ValidationException(implode('; ', $errors));
        }
        if (count($eq['bands']) > self::MAX_BANDS) {
            $errors[] = 'eq.bands: max ' . self::MAX_BANDS;
        }
        $bands = [];
        foreach (array_values($eq['bands']) as $i => $b) {
            if (!is_array($b)) { $errors[] = "bands[$i]: object required"; continue; }
            $type = $b['type'] ?? 'bell';
            if (!in_array($type, self::TYPES, true)) { $errors[] = "bands[$i].type invalid"; continue; }
            $freq = self::num($b['freq'] ?? null, 10, 30000, "bands[$i].freq", $errors);
            $gain = self::num($b['gain'] ?? 0, -30, 30, "bands[$i].gain", $errors);
            $q = self::num($b['q'] ?? 1, 0.025, 40, "bands[$i].q", $errors);
            $slope = (int)($b['slope'] ?? 12);
            if (!in_array($slope, self::SLOPES, true)) { $errors[] = "bands[$i].slope invalid"; }
            $placement = $b['placement'] ?? 'stereo';
            if (!in_array($placement, self::PLACEMENTS, true)) { $errors[] = "bands[$i].placement invalid"; }
            $bands[] = [
                'type' => $type,
                'freq' => $freq,
                'gain' => $gain,
                'q' => $q,
                'slope' => $slope,
                'placement' => $placement,
                'enabled' => !isset($b['enabled']) || (bool)$b['enabled'],
            ];
        }
        $mode = $eq['mode'] ?? 'zero';
        if (!in_array($mode, self::MODES, true)) { $errors[] = 'eq.mode invalid'; }
        $out = self::num($eq['outputGain'] ?? 0, -36, 36, 'eq.outputGain', $errors);
        if ($errors) {
            throw new ValidationException(implode('; ', $errors));
        }
        return [
            'name' => $name,
            'author' => self::str($in['author'] ?? 'User', 40),
            'category' => self::str($in['category'] ?? 'User', 32),
            'version' => 1,
            'eq' => [
                'mode' => $mode,
                'autoGain' => (bool)($eq['autoGain'] ?? false),
                'outputGain' => $out,
                'bands' => $bands,
            ],
        ];
    }

    private static function num($v, float $min, float $max, string $field, array &$errors): float
    {
        if (!is_numeric($v)) { $errors[] = "$field: number required"; return $min; }
        $f = (float)$v;
        if (!is_finite($f) || $f < $min || $f > $max) { $errors[] = "$field: out of range [$min, $max]"; }
        return round(max($min, min($max, $f)), 4);
    }

    private static function str($v, int $max): string
    {
        $s = is_string($v) ? trim(strip_tags($v)) : '';
        return mb_substr($s, 0, $max);
    }
}

/**
 * Валидатор пресетов Movexe DeEss / Movexe DeEss preset validator.
 * Формат (плоский) / flat format:
 * { name, category, plugin:"deesser", mode, processing, slope, filterShape, frequency, range, threshold,
 *   knee, attack, release, lookahead, outputGain, mix, stereoLink, autoThreshold, autoLevel, channelMode }
 */
final class DeEssValidator
{
    public const CATEGORIES = ['Vocal', 'Podcast', 'Rap', 'Pop', 'Rock', 'Custom'];
    /** Пределы числовых параметров / numeric limits: [min, max, default] */
    public const NUM = [
        'frequency' => [1000, 20000, 6500],
        'range' => [0, 30, 8],
        'threshold' => [-60, 0, -24],
        'knee' => [0, 30, 6],
        'attack' => [0.05, 100, 1],
        'release' => [5, 1000, 60],
        'lookahead' => [0, 20, 2],
        'outputGain' => [-30, 30, 0],
        'mix' => [0, 100, 100],
        'stereoLink' => [0, 100, 100],
    ];
    public const ENUM = [
        'mode' => ['single-vocal', 'allround'],
        'processing' => ['split', 'wideband'],
        'filterShape' => ['highpass', 'bandpass'],
        'channelMode' => ['stereo', 'mid-side', 'left-right'],
    ];
    public const SLOPES = [6, 12, 24, 48];

    public static function clean(array $in): array
    {
        $errors = [];
        $name = isset($in['name']) && is_string($in['name']) ? trim($in['name']) : '';
        if ($name === '' || mb_strlen($name) > 64) { $errors[] = 'name: required, 1–64 chars'; }
        $cat = $in['category'] ?? 'Custom';
        if (!in_array($cat, self::CATEGORIES, true)) { $cat = 'Custom'; }
        $out = ['name' => $name, 'author' => mb_substr(trim(strip_tags((string)($in['author'] ?? 'User'))), 0, 40),
            'category' => $cat, 'plugin' => 'deesser', 'version' => 1];
        foreach (self::NUM as $k => [$min, $max, $def]) {
            $v = $in[$k] ?? $def;
            if (!is_numeric($v) || !is_finite((float)$v) || (float)$v < $min || (float)$v > $max) {
                $errors[] = "$k: number in [$min, $max] required";
                continue;
            }
            $out[$k] = round((float)$v, 3);
        }
        foreach (self::ENUM as $k => $list) {
            $v = $in[$k] ?? $list[0];
            if (!in_array($v, $list, true)) { $errors[] = "$k: one of " . implode('|', $list); continue; }
            $out[$k] = $v;
        }
        $slope = (int)($in['slope'] ?? 24);
        if (!in_array($slope, self::SLOPES, true)) { $errors[] = 'slope: 6|12|24|48'; }
        $out['slope'] = $slope;
        $out['autoThreshold'] = (bool)($in['autoThreshold'] ?? false);
        $out['autoLevel'] = (bool)($in['autoLevel'] ?? false);
        if ($errors) { throw new ValidationException(implode('; ', $errors)); }
        return $out;
    }
}

/**
 * Валидатор пресетов Movexe EQ Lite (графический EQ в духе API 560).
 * Movexe EQ Lite preset validator. Формат / format:
 * { name, category, plugin:"lite", bands:[{freq:31,gain:0}, … ×10], mode, bypass, upsampling, analog, autoGain, outputGain }
 */
final class LiteValidator
{
    public const FREQS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    public const CATEGORIES = ['Vocal', 'Snare', 'Kick', 'Guitar', 'Bass', 'Room', 'Custom'];
    public const MODES = ['stereo', 'mono', 'mid', 'side'];
    public const UPSAMPLING = [1, 2, 4, 8];

    public static function clean(array $in): array
    {
        $errors = [];
        $name = isset($in['name']) && is_string($in['name']) ? trim($in['name']) : '';
        if ($name === '' || mb_strlen($name) > 64) { $errors[] = 'name: required, 1–64 chars'; }
        $gains = array_fill(0, 10, 0.0);
        if (!isset($in['bands']) || !is_array($in['bands']) || count($in['bands']) > 10) {
            $errors[] = 'bands: array of up to 10 {freq, gain}';
        } else {
            foreach (array_values($in['bands']) as $k => $b) {
                $i = is_array($b) ? array_search((int)($b['freq'] ?? 0), self::FREQS, true) : false;
                $g = is_array($b) ? ($b['gain'] ?? null) : null;
                if ($i === false) { $errors[] = "bands[$k].freq: one of " . implode(',', self::FREQS); continue; }
                if (!is_numeric($g) || abs((float)$g) > 12) { $errors[] = "bands[$k].gain: number in [-12, 12]"; continue; }
                $gains[$i] = round((float)$g, 2);
            }
        }
        $mode = $in['mode'] ?? 'stereo';
        if (!in_array($mode, self::MODES, true)) { $errors[] = 'mode: stereo|mono|mid|side'; }
        $up = (int)($in['upsampling'] ?? 4);
        if (!in_array($up, self::UPSAMPLING, true)) { $errors[] = 'upsampling: 1|2|4|8'; }
        $out = $in['outputGain'] ?? 0;
        if (!is_numeric($out) || abs((float)$out) > 18) { $errors[] = 'outputGain: number in [-18, 18]'; }
        if ($errors) { throw new ValidationException(implode('; ', $errors)); }
        $cat = in_array($in['category'] ?? '', self::CATEGORIES, true) ? $in['category'] : 'Custom';
        return [
            'name' => $name,
            'author' => mb_substr(trim(strip_tags((string)($in['author'] ?? 'User'))), 0, 40),
            'category' => $cat, 'plugin' => 'lite', 'version' => 1,
            'bands' => array_map(fn($f, $g) => ['freq' => $f, 'gain' => $g], self::FREQS, $gains),
            'mode' => $mode,
            'bypass' => (bool)($in['bypass'] ?? false),
            'upsampling' => $up,
            'analog' => (bool)($in['analog'] ?? true),
            'autoGain' => (bool)($in['autoGain'] ?? false),
            'outputGain' => round((float)$out, 2),
        ];
    }
}

/**
 * Валидатор пресетов Movexe DeNoise / Movexe DeNoise preset validator.
 * Тяжёлый профиль шума хранится отдельно (noise-profiles/), в пресете — его id
 * (или встроенный "profile", если сервер был недоступен при сохранении).
 */
final class DenoiseValidator
{
    public const CATEGORIES = ['Vocal', 'Podcast', 'Room', 'HVAC', 'Electrical', 'Field Recording', 'Custom'];
    public const NUM = [
        'reduction' => [0, 40, 18], 'threshold' => [-80, 0, -70], 'attack' => [0.1, 100, 5], 'release' => [10, 1000, 150],
        'smoothing' => [0, 100, 50], 'highCut' => [0, 100, 0], 'lowCut' => [0, 100, 0], 'artifactControl' => [0, 100, 60],
        'tone' => [0, 100, 20], 'stereoLink' => [0, 100, 100], 'mix' => [0, 100, 100], 'outputGain' => [-12, 12, 0],
        'learnSeconds' => [2, 5, 3],
    ];
    public const ENUM = [
        'mode' => ['reduce', 'adaptive', 'learn', 'broadband', 'spectral', 'hybrid'],
        'algorithm' => ['broadband', 'spectral', 'hybrid'],
        'frequencyRange' => ['low', 'mid', 'high', 'full'],
        'channelMode' => ['stereo', 'mid-side', 'left-right', 'mono'],
    ];

    public static function clean(array $in): array
    {
        $errors = [];
        $name = isset($in['name']) && is_string($in['name']) ? trim($in['name']) : '';
        if ($name === '' || mb_strlen($name) > 64) { $errors[] = 'name: required, 1–64 chars'; }
        $out = ['name' => $name, 'author' => mb_substr(trim(strip_tags((string)($in['author'] ?? 'User'))), 0, 40),
            'category' => in_array($in['category'] ?? '', self::CATEGORIES, true) ? $in['category'] : 'Custom',
            'plugin' => 'denoise', 'version' => 1];
        foreach (self::NUM as $k => [$min, $max, $def]) {
            $v = $in[$k] ?? $def;
            if (!is_numeric($v) || (float)$v < $min || (float)$v > $max) { $errors[] = "$k: number in [$min, $max]"; continue; }
            $out[$k] = round((float)$v, 3);
        }
        foreach (self::ENUM as $k => $list) {
            $v = $in[$k] ?? $list[0];
            if (!in_array($v, $list, true)) { $errors[] = "$k: one of " . implode('|', $list); continue; }
            $out[$k] = $v;
        }
        // Структура из ТЗ: mode может быть алгоритмом / spec structure: mode may be an algorithm
        if (in_array($out['mode'] ?? '', self::ENUM['algorithm'], true)) { $out['algorithm'] = $out['mode']; $out['mode'] = 'reduce'; }
        if (($out['mode'] ?? '') === 'learn') { $out['mode'] = 'reduce'; }
        $out['adaptive'] = (bool)($in['adaptive'] ?? false);
        foreach (['reductionCurve', 'profileOffset'] as $k) {
            $c = $in[$k] ?? null;
            if ($c === null) { $out[$k] = null; continue; }
            if (!is_array($c) || count($c) !== 96) { $errors[] = "$k: null or 96 values"; continue; }
            $out[$k] = array_map(fn($v) => $v === null ? null : max(-60, min(60, round((float)$v, 1))), array_values($c));
        }
        $np = $in['noiseProfile'] ?? null;
        $out['noiseProfile'] = is_string($np) && preg_match('/^[a-z0-9][a-z0-9\-]{0,63}$/', $np) ? $np : null;
        if (isset($in['profile']) && is_array($in['profile'])) { $out['profile'] = NoiseProfileStorage::cleanProfile($in['profile']); }
        if ($errors) { throw new ValidationException(implode('; ', $errors)); }
        return $out;
    }
}

/**
 * Хранилище профилей шума (noise prints): /noise-profiles/*.json (заводские, только чтение)
 * и /noise-profiles/user/*.json. Массивы тяжёлые (1025 бинов), поэтому отдельно от пресетов.
 * Noise print storage, kept apart from presets because the arrays are heavy.
 */
final class NoiseProfileStorage
{
    private string $dir;
    private string $userDir;

    public function __construct(string $root)
    {
        $this->dir = rtrim($root, '/');
        $this->userDir = $this->dir . '/user';
        if (!is_dir($this->userDir) && !@mkdir($this->userDir, 0775, true) && !is_dir($this->userDir)) {
            throw new RuntimeException('Cannot create noise profile directory');
        }
    }

    /** Проверка и нормализация профиля / validate & normalise a profile. */
    public static function cleanProfile(array $in): array
    {
        $n = (int)($in['fftSize'] ?? 0);
        $fs = (int)($in['sampleRate'] ?? 0);
        $bins = $in['bins'] ?? null;
        if ($n < 256 || $n > 32768 || ($n & ($n - 1))) { throw new ValidationException('fftSize: power of two 256…32768'); }
        if ($fs < 8000 || $fs > 192000) { throw new ValidationException('sampleRate: 8000…192000'); }
        if (!is_array($bins) || count($bins) !== intdiv($n, 2) + 1) { throw new ValidationException('bins: fftSize/2+1 numbers required'); }
        $clean = [];
        foreach ($bins as $v) {
            if (!is_numeric($v)) { throw new ValidationException('bins: numbers only'); }
            $clean[] = max(-160, min(40, round((float)$v, 1)));
        }
        $name = isset($in['name']) && is_string($in['name']) ? mb_substr(trim(strip_tags($in['name'])), 0, 64) : 'Профиль шума';
        return ['format' => 'movexe-noise-print', 'version' => 1, 'name' => $name ?: 'Профиль шума',
            'sampleRate' => $fs, 'fftSize' => $n, 'bins' => $clean];
    }

    private function read(string $f): ?array
    {
        $raw = @file_get_contents($f);
        $d = $raw === false ? null : json_decode($raw, true);
        return is_array($d) ? $d : null;
    }

    public function all(): array
    {
        $out = [];
        foreach ([[$this->dir, true], [$this->userDir, false]] as [$dir, $factory]) {
            foreach (glob($dir . '/*.json') ?: [] as $f) {
                if (basename($f) === 'index.json') { continue; }
                $p = $this->read($f);
                if ($p) { $out[] = ['id' => basename($f, '.json'), 'name' => $p['name'] ?? '', 'factory' => $factory, 'fftSize' => $p['fftSize'] ?? 0, 'sampleRate' => $p['sampleRate'] ?? 0]; }
            }
        }
        return $out;
    }

    public function get(string $id): array
    {
        if (!PresetStorage::validId($id) || $id === 'index') { throw new NotFoundException('Noise profile not found'); }
        foreach ([[$this->userDir, false], [$this->dir, true]] as [$dir, $factory]) {
            $p = is_file("$dir/$id.json") ? $this->read("$dir/$id.json") : null;
            if ($p) { $p['id'] = $id; $p['factory'] = $factory; return $p; }
        }
        throw new NotFoundException('Noise profile not found');
    }

    public function create(array $in): array
    {
        $p = self::cleanProfile($in);
        $p['created'] = gmdate('c');
        $id = 'np-' . bin2hex(random_bytes(6));
        $tmp = "{$this->userDir}/$id.json." . bin2hex(random_bytes(3)) . '.tmp';
        if (file_put_contents($tmp, json_encode($p, JSON_UNESCAPED_UNICODE)) === false || !rename($tmp, "{$this->userDir}/$id.json")) {
            @unlink($tmp);
            throw new RuntimeException('Write failed');
        }
        return $this->get($id);
    }

    public function delete(string $id): void
    {
        $p = $this->get($id);
        if (!empty($p['factory'])) { throw new ForbiddenException('Factory noise profiles are read-only'); }
        if (!@unlink("{$this->userDir}/$id.json")) { throw new RuntimeException('Delete failed'); }
    }
}

/** Тип пресета по содержимому / preset kind by content. */
function preset_kind(array $p): string
{
    $k = $p['plugin'] ?? '';
    return in_array($k, ['deesser', 'lite', 'denoise'], true) ? $k : 'eq';
}

final class PresetStorage
{
    private string $factoryDir;
    private string $userDir;
    /** @var array<string,string> заводские каталоги по типу / factory dirs by kind */
    private array $factoryDirs;

    public function __construct(string $root)
    {
        $this->factoryDir = rtrim($root, '/');
        $this->factoryDirs = ['eq' => $this->factoryDir, 'deesser' => $this->factoryDir . '/deesser', 'lite' => $this->factoryDir . '/lite', 'denoise' => $this->factoryDir . '/denoise'];
        $this->userDir = $this->factoryDir . '/user';
        if (!is_dir($this->userDir) && !@mkdir($this->userDir, 0775, true) && !is_dir($this->userDir)) {
            throw new RuntimeException('Cannot create user preset directory');
        }
    }

    /** Безопасный id: только [a-z0-9-] / safe id: only [a-z0-9-]. */
    public static function validId(string $id): bool
    {
        return (bool)preg_match('/^[a-z0-9][a-z0-9\-]{0,63}$/', $id);
    }

    private function read(string $file): ?array
    {
        $fh = @fopen($file, 'rb');
        if (!$fh) { return null; }
        flock($fh, LOCK_SH);
        $raw = stream_get_contents($fh);
        flock($fh, LOCK_UN);
        fclose($fh);
        $data = json_decode((string)$raw, true);
        return is_array($data) ? $data : null;
    }

    private function write(string $file, array $data): void
    {
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        // Атомарно: временный файл + rename, под эксклюзивной блокировкой.
        // Atomic: temp file + rename, under an exclusive lock.
        $lock = fopen($this->userDir . '/.lock', 'c');
        flock($lock, LOCK_EX);
        try {
            $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
            if (file_put_contents($tmp, $json) === false || !rename($tmp, $file)) {
                @unlink($tmp);
                throw new RuntimeException('Write failed');
            }
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private function meta(array $p): array
    {
        return [
            'id' => $p['id'],
            'name' => $p['name'] ?? $p['id'],
            'author' => $p['author'] ?? '',
            'category' => $p['category'] ?? '',
            'factory' => (bool)($p['factory'] ?? false),
            'plugin' => preset_kind($p),
            'bands' => isset($p['eq']['bands']) ? count($p['eq']['bands']) : (isset($p['bands']) && is_array($p['bands']) ? count($p['bands']) : 0),
            'updated' => $p['updated'] ?? null,
        ];
    }

    /** Список (только метаданные) для типа / list (metadata only) for a kind. */
    public function all(string $kind = 'eq'): array
    {
        $kind = in_array($kind, ['deesser', 'lite', 'denoise'], true) ? $kind : 'eq';
        $out = [];
        foreach (glob($this->factoryDirs[$kind] . '/*.json') ?: [] as $f) {
            if (basename($f) === 'index.json') { continue; }
            $p = $this->read($f);
            if ($p) { $p['id'] = basename($f, '.json'); $p['factory'] = true; if ($kind !== 'eq') { $p['plugin'] = $kind; } $out[] = $this->meta($p); }
        }
        foreach (glob($this->userDir . '/*.json') ?: [] as $f) {
            $p = $this->read($f);
            if ($p && preset_kind($p) === $kind) { $p['id'] = basename($f, '.json'); $p['factory'] = false; $out[] = $this->meta($p); }
        }
        usort($out, fn($a, $b) => [$b['factory'], $a['name']] <=> [$a['factory'], $b['name']]);
        return $out;
    }

    public function get(string $id): array
    {
        if (!self::validId($id) || $id === 'index') { throw new NotFoundException('Preset not found'); }
        $dirs = [[$this->userDir, false, null], [$this->factoryDirs['eq'], true, 'eq'], [$this->factoryDirs['deesser'], true, 'deesser'], [$this->factoryDirs['lite'], true, 'lite'], [$this->factoryDirs['denoise'], true, 'denoise']];
        foreach ($dirs as [$dir, $factory, $kind]) {
            $f = "$dir/$id.json";
            if (is_file($f)) {
                $p = $this->read($f);
                if ($p) {
                    $p['id'] = $id;
                    $p['factory'] = $factory;
                    if ($kind && $kind !== 'eq') { $p['plugin'] = $kind; }
                    return $p;
                }
            }
        }
        throw new NotFoundException('Preset not found');
    }

    /** Валидация по типу / validation by kind. */
    private static function validate(array $input): array
    {
        switch (preset_kind($input)) {
            case 'deesser': return DeEssValidator::clean($input);
            case 'lite': return LiteValidator::clean($input);
            case 'denoise': return DenoiseValidator::clean($input);
            default: return PresetValidator::clean($input);
        }
    }

    public function create(array $input): array
    {
        $p = self::validate($input);
        $base = trim((string)preg_replace('/[^a-z0-9]+/', '-', strtolower(self::translit($p['name']))), '-') ?: 'preset';
        $id = substr($base, 0, 40) . '-' . bin2hex(random_bytes(3));
        $now = gmdate('c');
        $p += ['created' => $now];
        $p['updated'] = $now;
        $this->write("{$this->userDir}/$id.json", $p);
        return $this->get($id);
    }

    public function update(string $id, array $input): array
    {
        $cur = $this->get($id);
        if (!empty($cur['factory'])) { throw new ForbiddenException('Factory presets are read-only'); }
        $p = self::validate($input + ['name' => $cur['name'], 'plugin' => preset_kind($cur)]);
        $p['created'] = $cur['created'] ?? gmdate('c');
        $p['updated'] = gmdate('c');
        $this->write("{$this->userDir}/$id.json", $p);
        return $this->get($id);
    }

    public function delete(string $id): void
    {
        $cur = $this->get($id);
        if (!empty($cur['factory'])) { throw new ForbiddenException('Factory presets are read-only'); }
        if (!@unlink("{$this->userDir}/$id.json")) { throw new RuntimeException('Delete failed'); }
    }

    /** Экспорт всех пользовательских пресетов пакетом / export all user presets as a bundle. */
    public function exportBundle(): array
    {
        $items = [];
        foreach (glob($this->userDir . '/*.json') ?: [] as $f) {
            $p = $this->read($f);
            if ($p) { unset($p['id'], $p['factory']); $items[] = $p; }
        }
        return ['format' => 'proeq-presets', 'version' => 1, 'exported' => gmdate('c'), 'presets' => $items];
    }

    /** Импорт: один пресет или пакет / import a single preset or a bundle. */
    public function import(array $data): array
    {
        $list = isset($data['presets']) && is_array($data['presets']) ? $data['presets'] : [$data];
        if (count($list) > 200) { throw new ValidationException('Too many presets in bundle (max 200)'); }
        $created = [];
        foreach ($list as $p) {
            if (is_array($p)) { $created[] = $this->meta($this->create($p)); }
        }
        return $created;
    }

    private static function translit(string $s): string
    {
        $map = ['а'=>'a','б'=>'b','в'=>'v','г'=>'g','д'=>'d','е'=>'e','ё'=>'e','ж'=>'zh','з'=>'z','и'=>'i','й'=>'y','к'=>'k',
            'л'=>'l','м'=>'m','н'=>'n','о'=>'o','п'=>'p','р'=>'r','с'=>'s','т'=>'t','у'=>'u','ф'=>'f','х'=>'h','ц'=>'c',
            'ч'=>'ch','ш'=>'sh','щ'=>'sch','ъ'=>'','ы'=>'y','ь'=>'','э'=>'e','ю'=>'yu','я'=>'ya'];
        return strtr(mb_strtolower($s), $map);
    }
}
