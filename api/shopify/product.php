<?php
declare(strict_types=1);

require __DIR__ . '/_lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    header('Allow: GET');
    send_json(405, ['error' => 'Method Not Allowed']);
}

$handle = trim((string) ($_GET['handle'] ?? ''));

if ($handle === '') {
    send_json(400, ['error' => 'Missing required handle parameter.']);
}

try {
    $product = fetch_product($handle);
    send_json(200, ['product' => $product], 'public, max-age=300, stale-while-revalidate=900');
} catch (Throwable $error) {
    send_json(500, [
        'error' => 'Unable to fetch the requested live product.',
        'detail' => $error->getMessage(),
    ]);
}
