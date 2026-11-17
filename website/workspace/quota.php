<?php
declare(strict_types=1);

require __DIR__ . '/lib.php';

sf_ws_headers();

if (!sf_ws_authorized()) {
    http_response_code(403);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'forbidden'], JSON_UNESCAPED_UNICODE);
    exit;
}

header('Content-Type: application/json; charset=utf-8');

header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$forceQuery = (isset($_GET['force']) && $_GET['force'] === '1') ? '?force=1' : '';
if (function_exists('curl_init')) {
    $ch = curl_init('http://127.0.0.1:18014/live' . $forceQuery);
    if ($ch !== false) {
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT_MS => 1500,
            CURLOPT_TIMEOUT_MS => ($forceQuery !== '' ? 9000 : 6000),
            CURLOPT_HTTPHEADER => ['Accept: application/json'],
        ]);
        $liveBody = curl_exec($ch);
        $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if (is_string($liveBody) && $httpCode === 200) {
            $decoded = json_decode($liveBody, true);
            if (is_array($decoded) && isset($decoded['providers'])) {
                $decoded['source'] = 'live';
                header('X-Quota-Source: live');
                echo json_encode($decoded, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                exit;
            }
        }
    }
}

header('X-Quota-Source: cache');
$file = '/www/wwwroot/156.239.8.225/wp-content/sf-private/quota.json';
if (!is_readable($file)) {
    http_response_code(503);
    echo json_encode(['error' => 'quota_unavailable'], JSON_UNESCAPED_UNICODE);
    exit;
}

$raw = @file_get_contents($file);
if ($raw === false || trim($raw) === '') {
    http_response_code(503);
    echo json_encode(['error' => 'quota_empty'], JSON_UNESCAPED_UNICODE);
    exit;
}

echo $raw;
