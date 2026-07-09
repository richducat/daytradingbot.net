<?php
declare(strict_types=1);

const DEFAULT_STOREFRONT_ORIGIN = 'https://28shungite.com';
const SYSTEM_COLLECTIONS = ['home-page' => true];
const HIDDEN_COLLECTION_PATTERN = '/-\d+$/';

function storefront_origin(): string
{
    $origin = getenv('SHOPIFY_STOREFRONT_ORIGIN') ?: DEFAULT_STOREFRONT_ORIGIN;
    return rtrim((string) $origin, '/');
}

function send_json(int $statusCode, array $payload, ?string $cacheControl = null): never
{
    http_response_code($statusCode);
    header('Content-Type: application/json; charset=utf-8');

    if ($cacheControl) {
        header("Cache-Control: {$cacheControl}");
    }

    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function request_status_code(array $headers): int
{
    $statusLine = $headers[0] ?? '';

    if (preg_match('/\s(\d{3})\s/', $statusLine, $matches)) {
        return (int) $matches[1];
    }

    return 0;
}

function fetch_storefront_json(string $pathname): array
{
    $url = storefront_origin() . $pathname;
    $headers = "Accept: application/json\r\nUser-Agent: 28shungite-staging/1.0";

    if (function_exists('curl_init')) {
        $handle = curl_init($url);
        curl_setopt_array($handle, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_HTTPHEADER => [
                'Accept: application/json',
                'User-Agent: 28shungite-staging/1.0',
            ],
            CURLOPT_TIMEOUT => 10,
        ]);

        $raw = curl_exec($handle);
        $statusCode = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);
    } else {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'timeout' => 10,
                'header' => $headers,
                'ignore_errors' => true,
            ],
        ]);

        $raw = @file_get_contents($url, false, $context);
        $responseHeaders = $http_response_header ?? [];
        $statusCode = request_status_code($responseHeaders);
    }

    if ($raw === false || $statusCode < 200 || $statusCode >= 300) {
        throw new RuntimeException("Storefront request failed with {$statusCode}");
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        throw new RuntimeException('Unable to decode storefront response.');
    }

    return $decoded;
}

function money($rawValue): array
{
    $amount = 0.0;

    if (is_string($rawValue) && strpos($rawValue, '.') !== false) {
        $amount = (float) $rawValue;
    } else {
        $amount = ((float) ($rawValue ?? 0)) / 100;
    }

    return [
        'amount' => $amount,
        'formatted' => '$' . number_format($amount, 2, '.', ','),
    ];
}

function to_https_url($url): string
{
    $value = trim((string) ($url ?? ''));

    if ($value === '') {
        return '';
    }

    if (strpos($value, '//') === 0) {
        return 'https:' . $value;
    }

    return $value;
}

function strip_html_text($html): string
{
    $value = (string) ($html ?? '');
    $value = preg_replace('/<br\s*\/?>/i', "\n", $value) ?? $value;
    $value = preg_replace('/<\/p>/i', "\n", $value) ?? $value;
    $value = strip_tags($value);
    $value = preg_replace("/\n{2,}/", "\n", $value) ?? $value;

    return trim($value);
}

function build_description_lines($html): array
{
    $lines = preg_split('/\r?\n/', strip_html_text($html)) ?: [];

    return array_values(array_filter(array_map('trim', $lines), static function ($line) {
        return $line !== '';
    }));
}

function excerpt_text($html): string
{
    $plainText = preg_replace('/\s+/', ' ', strip_html_text($html)) ?? '';
    $plainText = trim($plainText);

    if (strlen($plainText) <= 140) {
        return $plainText;
    }

    return rtrim(substr($plainText, 0, 137)) . '...';
}

function type_label(array $product): string
{
    return trim((string) ($product['product_type'] ?? ''));
}

function eyebrow_label(array $product): string
{
    $handle = (string) ($product['handle'] ?? '');

    if ($handle === 'shungite-starter-kit') {
        return 'New Collection — Ancient Earth';
    }
    return '';
}

function image_url_from_value($value): string
{
    if (is_string($value)) {
        return to_https_url($value);
    }

    if (is_array($value)) {
        return to_https_url($value['src'] ?? $value['url'] ?? '');
    }

    return '';
}

function normalize_variant(array $variant): array
{
    return [
        'id' => $variant['id'] ?? null,
        'available' => (bool) ($variant['available'] ?? false),
        'price' => money($variant['price'] ?? 0),
        'title' => (string) ($variant['public_title'] ?? $variant['title'] ?? 'Default Title'),
    ];
}

function normalize_product(array $product): array
{
    $priceSource = $product['price_min'] ?? $product['price'] ?? ($product['variants'][0]['price'] ?? 0);
    $compareAtSource = $product['compare_at_price_min'] ?? $product['compare_at_price'] ?? ($product['variants'][0]['compare_at_price'] ?? null);

    $images = [];
    foreach (($product['images'] ?? []) as $image) {
        $url = image_url_from_value($image);
        if ($url !== '') {
            $images[] = $url;
        }
    }

    $featuredImage = image_url_from_value($product['featured_image'] ?? '') ?: ($images[0] ?? '');

    $variants = array_map('normalize_variant', $product['variants'] ?? []);
    $primaryVariant = null;
    foreach ($variants as $variant) {
        if ($variant['available']) {
            $primaryVariant = $variant;
            break;
        }
    }
    if ($primaryVariant === null && count($variants) > 0) {
        $primaryVariant = $variants[0];
    }

    $available = array_key_exists('available', $product)
        ? (bool) $product['available']
        : count(array_filter($variants, static function ($variant) {
            return !empty($variant['available']);
        })) > 0;

    $liveProductUrl = storefront_origin() . ($product['url'] ?? '/products/' . rawurlencode((string) ($product['handle'] ?? '')));
    $compareAtPrice = null;
    if ($compareAtSource !== null && (float) $compareAtSource > 0) {
        $compareAtPrice = money($compareAtSource);
    }

    return [
        'available' => $available,
        'compareAtPrice' => $compareAtPrice,
        'descriptionHtml' => (string) ($product['body_html'] ?? $product['description'] ?? ''),
        'descriptionLines' => build_description_lines($product['body_html'] ?? $product['description'] ?? ''),
        'excerpt' => excerpt_text($product['body_html'] ?? $product['description'] ?? ''),
        'eyebrow' => eyebrow_label($product),
        'featuredImage' => $featuredImage,
        'handle' => (string) ($product['handle'] ?? ''),
        'id' => $product['id'] ?? null,
        'images' => count($images) > 0 ? $images : ($featuredImage !== '' ? [$featuredImage] : []),
        'liveCartUrl' => $primaryVariant ? storefront_origin() . '/cart/' . $primaryVariant['id'] . ':1' : $liveProductUrl,
        'liveProductUrl' => $liveProductUrl,
        'price' => money($priceSource),
        'title' => (string) ($product['title'] ?? ''),
        'typeLabel' => type_label($product),
        'variants' => $variants,
    ];
}

function normalize_collection(array $collection): array
{
    $handle = (string) ($collection['handle'] ?? '');

    return [
        'handle' => $handle,
        'title' => $handle === 'frontpage' ? 'Featured' : (string) ($collection['title'] ?? $handle),
        'productsCount' => (int) ($collection['products_count'] ?? 0),
    ];
}

function fetch_products(string $collection = 'all', int $limit = 24): array
{
    $normalizedLimit = max(1, min(250, $limit));
    $path = $collection !== '' && $collection !== 'all'
        ? '/collections/' . rawurlencode($collection) . '/products.json?limit=' . $normalizedLimit
        : '/products.json?limit=' . $normalizedLimit;

    $payload = fetch_storefront_json($path);

    return array_map('normalize_product', $payload['products'] ?? []);
}

function fetch_product(string $handle): array
{
    $payload = fetch_storefront_json('/products/' . rawurlencode($handle) . '.js');
    return normalize_product($payload);
}

function fetch_collections(): array
{
    $payload = fetch_storefront_json('/collections.json?limit=50');
    $collections = [];

    foreach (($payload['collections'] ?? []) as $collection) {
        $handle = (string) ($collection['handle'] ?? '');
        $count = (int) ($collection['products_count'] ?? 0);

        if (isset(SYSTEM_COLLECTIONS[$handle])) {
            continue;
        }

        if (preg_match(HIDDEN_COLLECTION_PATTERN, $handle)) {
            continue;
        }

        if ($count <= 0) {
            continue;
        }

        $collections[] = normalize_collection($collection);
    }

    return $collections;
}
