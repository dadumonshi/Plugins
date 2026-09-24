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

final class PresetStorage
{
    private string $factoryDir;
    private string $userDir;

    public function __construct(string $root)
    {
        $this->factoryDir = rtrim($root, '/');
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
            'bands' => isset($p['eq']['bands']) ? count($p['eq']['bands']) : 0,
            'updated' => $p['updated'] ?? null,
        ];
    }

    /** Список (только метаданные) / list (metadata only). */
    public function all(): array
    {
        $out = [];
        foreach (glob($this->factoryDir . '/*.json') ?: [] as $f) {
            if (basename($f) === 'index.json') { continue; }
            $p = $this->read($f);
            if ($p) { $p['id'] = basename($f, '.json'); $p['factory'] = true; $out[] = $this->meta($p); }
        }
        foreach (glob($this->userDir . '/*.json') ?: [] as $f) {
            $p = $this->read($f);
            if ($p) { $p['id'] = basename($f, '.json'); $p['factory'] = false; $out[] = $this->meta($p); }
        }
        usort($out, fn($a, $b) => [$b['factory'], $a['name']] <=> [$a['factory'], $b['name']]);
        return $out;
    }

    public function get(string $id): array
    {
        if (!self::validId($id)) { throw new NotFoundException('Preset not found'); }
        foreach ([[$this->userDir, false], [$this->factoryDir, true]] as [$dir, $factory]) {
            $f = "$dir/$id.json";
            if ($id !== 'index' && is_file($f)) {
                $p = $this->read($f);
                if ($p) { $p['id'] = $id; $p['factory'] = $factory; return $p; }
            }
        }
        throw new NotFoundException('Preset not found');
    }

    public function create(array $input): array
    {
        $p = PresetValidator::clean($input);
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
        $p = PresetValidator::clean($input + ['name' => $cur['name']]);
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
