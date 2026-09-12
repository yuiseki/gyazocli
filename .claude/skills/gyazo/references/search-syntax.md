# Gyazo search syntax, as measured

Every operator here was run against the live API with a value that should
match, and the results were read back from the image detail endpoint to confirm
the filter had actually applied. Counting results is not enough: a lean search
response does not carry the field being filtered on, so a count can look right
while the filter does nothing.

Measured on 2026-09-09 and 2026-09-12.

## Contents

- [Operators that work](#operators-that-work)
- [Operators that do not exist](#operators-that-do-not-exist)
- [Combining terms](#combining-terms)
- [Photographs versus screenshots](#photographs-versus-screenshots)
- [What a search result does not contain](#what-a-search-result-does-not-contain)

## Operators that work

| Operator | Matches | Notes |
| --- | --- | --- |
| bare words | OCR text, title, description | `お好み焼` |
| `address:` | the reverse-geocoded address of a capture with GPS | any language, any case, postal codes too: `address:広島`, `address:Hiroshima`, `address:730-0041` all find the same photos |
| `date:` | upload date | `date:2026-08-30`, `date:2026-08`, `date:2026` |
| `since:` / `until:` | upload date range | `since:2026-08-30 until:2026-08-31` |
| `app:` | the application the capture came from | quote a value with spaces: `app:"Gyazo Android"` |
| `title:`, `url:`, `desc:` | the page it was captured from | |
| `ocr:` | the text in the image | |
| `type:` | the file type | `type:png` |
| `has:location` | captures with coordinates | |
| `has:exif` | captures with EXIF | not the same set as `has:location` |

## Operators that do not exist

`location:`, `geo:`, `near:`, `bbox:`, `latlng:`, `city:`, `pref:`,
`locality:`, `admin1:`, `country:`, `postal:`, `zip:`, `lat:`, `lng:`,
`place:`, `around:`, `within:`, `radius:`, `before:`, `after:`, `day:`,
`has:ocr`, `has:address`.

All of them return zero results, exactly as an invented operator does
(`zzz:広島` returns nothing while `広島` returns many). **Zero results from an
unfamiliar operator means the operator, not the account.** Retry with a known
one before concluding the captures do not exist.

There is no coordinate or radius search of any kind. To search by place, use
`address:` with a place name.

## Combining terms

- Terms are ANDed: `address:広島 address:東京` returns nothing, because no
  capture is in both places.
- `OR` in capitals works: `address:広島 OR address:東京`.
- `|` does not work.
- A leading `-` negates: `has:location -address:広島`.

## Photographs versus screenshots

`has:exif` is the filter that means photographs. The application does not tell
them apart: one page of `app:"Gyazo Android" -has:exif` came back as 68 gif and
30 png against 2 jpg, which is screen recordings and screenshots from the same
phone.

`has:exif` and `has:location` overlap without either containing the other. A
photo taken indoors has EXIF and no coordinates; 86 captures in the account
tested carried coordinates without the EXIF flag. `has:exif OR has:location` is
the widest reading of "a photo".

## What a search result does not contain

The search and listing endpoints return a lean image: `metadata` holds `app`,
`desc`, `title`, `url` and `original_*`, and nothing else. No coordinates, no
address, no matter what the capture carries. Checked against a full page of 100
where not one item had either field.

Coordinates and addresses only come back from the detail endpoint, which is
what `gyazo get <image_id> --json` calls. To answer "where were these taken",
search for the IDs and then read each one; `gyazo` caches each detail, so the
second pass over the same captures is local.
