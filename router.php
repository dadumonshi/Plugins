<?php
/**
 * router.php — роутер для встроенного сервера PHP (разработка).
 * router.php — router for PHP's built-in server (development).
 *
 *   php -S 0.0.0.0:8000 router.php
 *   → http://localhost:8000  (микрофон работает на localhost без HTTPS / mic works on localhost)
 */
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/api/#', $path)) {
    require __DIR__ . '/php/api.php';
    return true;
}
if ($path === '/php/storage.php') {
    http_response_code(403);
    return true;
}
if ($path === '/sw.js') {
    header('Cache-Control: no-cache');
    header('Content-Type: text/javascript');
    readfile(__DIR__ . '/sw.js');
    return true;
}
return false; // статика отдаётся как есть / serve static files as-is
