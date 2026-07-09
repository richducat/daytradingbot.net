<?php
declare(strict_types=1);

require __DIR__ . '/_lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    header('Allow: GET');
    send_json(405, ['error' => 'Method Not Allowed']);
}

try {
    $collections = fetch_collections();
    send_json(200, ['collections' => $collections], 'public, max-age=900, stale-while-revalidate=1800');
} catch (Throwable $error) {
    send_json(500, [
        'error' => 'Unable to fetch Shopify collections.',
        'detail' => $error->getMessage(),
    ]);
}
