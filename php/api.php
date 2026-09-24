<?php
/**
 * api.php — REST API пресетов / presets REST API.
 *
 *   GET    /api/presets           — список / list (metadata)
 *   POST   /api/presets           — создать / create
 *   GET    /api/presets/{id}      — получить / get   (?download=1 → файл / as file)
 *   PUT    /api/presets/{id}      — обновить / update
 *   DELETE /api/presets/{id}      — удалить / delete
 *   GET    /api/presets/export    — экспорт всех пользовательских / export all user presets
 *   POST   /api/presets/import    — импорт пресета или пакета / import a preset or bundle
 *
 * Маршрут берётся из PATH_INFO (php/api.php/presets/..), ?route=presets/.. или REQUEST_URI (/api/..).
 * Route comes from PATH_INFO, ?route= or REQUEST_URI.
 */
declare(strict_types=1);

require __DIR__ . '/storage.php';

/* ---------------- CORS (мобильные приложения/другие origin) ---------------- */
$allowed = getenv('PROEQ_CORS_ORIGIN') ?: '*';
header('Access-Control-Allow-Origin: ' . $allowed);
if ($allowed !== '*') { header('Vary: Origin'); }
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Accept, X-Requested-With');
header('Access-Control-Max-Age: 86400');
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function respond(int $code, array $body): void
{
    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
// Некоторые прокси/старые клиенты не умеют PUT/DELETE / method override for limited clients
if ($method === 'POST' && isset($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'])) {
    $method = strtoupper($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE']);
}
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/* ---------------- маршрут / route ---------------- */
$route = $_GET['route'] ?? ($_SERVER['PATH_INFO'] ?? '');
if ($route === '') {
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?: '';
    if (preg_match('#/api/(.*)$#', $path, $m)) { $route = $m[1]; }
}
// Встроенный сервер PHP кладёт в PATH_INFO полный путь «/api/…» / built-in server puts "/api/…" in PATH_INFO
$route = (string)preg_replace('#^/?api/#', '', (string)$route);
$parts = array_values(array_filter(explode('/', trim((string)$route, '/')), 'strlen'));
if (($parts[0] ?? '') !== 'presets' || count($parts) > 2) {
    respond(404, ['error' => 'Unknown endpoint. Use /api/presets']);
}
$id = isset($parts[1]) ? rawurldecode($parts[1]) : null;

function body(): array
{
    $raw = file_get_contents('php://input', false, null, 0, 262145);
    if ($raw === false || strlen($raw) > 262144) { respond(413, ['error' => 'Payload too large (max 256 KB)']); }
    $data = json_decode($raw, true);
    if (!is_array($data)) { respond(400, ['error' => 'Invalid JSON body']); }
    return $data;
}

try {
    $store = new PresetStorage(dirname(__DIR__) . '/presets');

    if ($id === null) {
        switch ($method) {
            case 'GET':
                respond(200, ['presets' => $store->all()]);
            case 'POST':
                respond(201, ['preset' => $store->create(body())]);
            default:
                respond(405, ['error' => 'Method not allowed']);
        }
    }

    if ($id === 'export' && $method === 'GET') {
        header('Content-Disposition: attachment; filename="proeq-presets.json"');
        respond(200, $store->exportBundle());
    }
    if ($id === 'import' && $method === 'POST') {
        respond(201, ['imported' => $store->import(body())]);
    }
    if (!PresetStorage::validId($id)) {
        respond(400, ['error' => 'Invalid preset id']);
    }

    switch ($method) {
        case 'GET':
            $p = $store->get($id);
            if (!empty($_GET['download'])) {
                $fn = preg_replace('/[^\w\-]+/u', '_', $p['name'] ?? $id);
                header('Content-Disposition: attachment; filename="' . $fn . '.proeq.json"');
                unset($p['factory']);
                respond(200, $p);
            }
            respond(200, ['preset' => $p]);
        case 'PUT':
            respond(200, ['preset' => $store->update($id, body())]);
        case 'DELETE':
            $store->delete($id);
            respond(200, ['deleted' => $id]);
        default:
            respond(405, ['error' => 'Method not allowed']);
    }
} catch (ValidationException $e) {
    respond(422, ['error' => $e->getMessage()]);
} catch (NotFoundException $e) {
    respond(404, ['error' => $e->getMessage()]);
} catch (ForbiddenException $e) {
    respond(403, ['error' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log('[proeq api] ' . $e->getMessage());
    respond(500, ['error' => 'Internal server error']);
}
