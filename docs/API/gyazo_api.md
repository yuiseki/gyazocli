# Gyazo API

Gyazo provides a REST API to access user images and metadata including OCR and object recognition results.

## Base URL

`https://api.gyazo.com/api`

## Authentication

Authentication is performed using an OAuth2 Access Token.

**Header:** `Authorization: Bearer {access_token}`

---

## Endpoints

### 1. List Images
`GET /images`

Fetch metadata for the user's images.

**Parameters:**
- `page` (int): Page number.
- `per_page` (int): Number of items per page (Max: 100).

### 2. Search Images
`GET /search`

Search for images using queries.

**Parameters:**
- `query` (string): Search query (e.g., `date:YYYY-MM-DD`).
- `page` (int): Page number.
- `per` (int): Number of items per page.

### 3. Get Image Detail
`GET /images/{image_id}`

Fetch detailed information for a specific image, including OCR and localized object annotations.

---

## Data Models

### Image Object
- `image_id`: Unique identifier.
- `permalink_url`: Gyazo page URL.
- `url`: Direct image URL.
- `type`: Image type (e.g., `png`, `jpg`).
- `created_at`: Creation timestamp (ISO 8601).
- `ocr`: OCR results (description and locale).
- `metadata`:
  - `title`: Window title at the time of capture.
  - `url`: Source URL of the capture.
  - `app`: Application name.
  - `exif_address`: Geolocation address from EXIF.

---

## Rate Limiting

If you exceed the rate limit, the API returns a `429 Too Many Requests` status code.
Check the `Retry-After` header for the number of seconds to wait before retrying.
