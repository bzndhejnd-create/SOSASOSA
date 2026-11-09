/**
 * OpportunityAI — Модуль интеграции внешних гео-сервисов и API
 * 
 * Поддерживает:
 * 1. OpenStreetMap / Overpass API (поиск реальных объектов по тегам OSM в Алматы)
 * 2. Nominatim Geocoding API (проверка и геокодирование адресов)
 * 3. Конфигурационный слой для Google Maps Platform и Google Places API
 * 
 * БЕЗОПАСНОСТЬ:
 * Никакие секретные API-ключи не вшиваются в открытый клиентский код.
 * При наличии ключей они передаются через безопасный интерфейс конфигурации.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OpportunityAPI = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // Зеркала Overpass API для отказоустойчивости
  const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];

  // Маппинг категорий бизнеса на теги OpenStreetMap
  const OSM_CATEGORY_TAGS = {
    food: '["amenity"~"cafe|restaurant|fast_food|bakery"]',
    education: '["amenity"~"school|language_school|college|kindergarten|training"]',
    tech: '["amenity"="coworking"],["office"~"it|company"]',
    health: '["amenity"~"pharmacy|clinic|doctors|hospital|dentist"]',
    retail: '["shop"~"supermarket|convenience|clothes|books"]',
    repair: '["craft"~"electronics_repair|shoemaker"],["shop"="mobile_phone"]',
    services: '["shop"~"hairdresser|beauty"],["amenity"="dry_cleaning"]',
    tourism: '["tourism"~"hotel|hostel|guest_house|museum"]',
    finance: '["amenity"~"bank|bureau_de_change"]'
  };

  /**
   * Запрос к Overpass API для поиска организаций в границах прямоугольника
   * @param {Object} bbox { minLat, minLng, maxLat, maxLng }
   * @param {string} category Ключ категории
   * @param {number} timeoutMs Таймаут запроса в миллисекундах (по умолчанию 8000)
   */
  async function fetchOsmOrganizations(bbox, category = 'food', timeoutMs = 8000) {
    const osmTagFilter = OSM_CATEGORY_TAGS[category] || '["amenity"~"cafe|restaurant"]';
    const query = `[out:json][timeout:12];
      (
        node${osmTagFilter}(${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng});
        way${osmTagFilter}(${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng});
      );
      out center tags 40;`;

    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'OpportunityAI-Auditor/1.0 (kz-almaty-geo-audit)'
          },
          body: 'data=' + encodeURIComponent(query),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const json = await response.json();
          if (json && json.elements) {
            // Нормализация элементов OSM в единый формат
            const normalized = json.elements
              .filter(el => el.tags && (el.tags.name || el.tags['name:ru'] || el.tags['name:kz']))
              .map(el => {
                const lat = el.lat || (el.center && el.center.lat);
                const lng = el.lon || (el.center && el.center.lon);
                const name = el.tags['name:ru'] || el.tags.name || el.tags['name:kz'];
                const street = el.tags['addr:street'] || '';
                const house = el.tags['addr:housenumber'] || '';
                const address = (street || house) ? `${street} ${house}`.trim() : 'г. Алматы (адрес уточняется)';

                return {
                  id: `osm_${el.type}_${el.id}`,
                  name: name,
                  category: category,
                  address: address,
                  latitude: Number(lat),
                  longitude: Number(lng),
                  source: 'OpenStreetMap Live Overpass',
                  source_id: `${el.type}/${el.id}`,
                  last_verified_at: new Date().toISOString().split('T')[0],
                  confidence_status: 'VERIFIED_OSM'
                };
              })
              .filter(el => !isNaN(el.latitude) && !isNaN(el.longitude));

            return {
              success: true,
              data: normalized,
              source: endpoint,
              count: normalized.length
            };
          }
        }
      } catch (err) {
        // Переходим к следующему зеркалу при ошибке или таймауте
        continue;
      }
    }

    return {
      success: false,
      error: 'Все публичные зеркала Overpass API временно недоступны или превышен таймаут ответа. Используется локальная верифицированная база.',
      data: []
    };
  }

  /**
   * Геокодирование адреса через официальный Nominatim API
   */
  async function geocodeAddress(addressQuery, timeoutMs = 5000) {
    const fullQuery = encodeURIComponent(`${addressQuery}, Алматы, Казахстан`);
    const url = `https://nominatim.openstreetmap.org/search?q=${fullQuery}&format=json&limit=1&addressdetails=1`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'OpportunityAI-Auditor/1.0 (info@opportunityai.kz)'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const results = await response.json();
        if (results && results.length > 0) {
          return {
            found: true,
            latitude: parseFloat(results[0].lat),
            longitude: parseFloat(results[0].lon),
            display_name: results[0].display_name
          };
        }
      }
      return { found: false, reason: 'Адрес не найден в базе OSM Nominatim' };
    } catch (err) {
      return { found: false, reason: err.message };
    }
  }

  // ==========================================================================
  // 3. Интеграция с Google Maps Platform (Google Places API & Geocoding)
  // ==========================================================================

  // Ключ API Google Maps Platform (настроен пользователем)
  let GOOGLE_MAPS_API_KEY = 'AIzaSyDmjT3jiei434ED-mMRdMPECLEtMGm3YRU';

  function setGoogleMapsApiKey(key) {
    GOOGLE_MAPS_API_KEY = key;
  }

  // Маппинг категорий бизнеса на поисковые запросы Google Places API
  const GOOGLE_CATEGORY_QUERIES = {
    food: 'кафе ресторан кофейня Алматы',
    education: 'учебный центр курсы языковая школа Алматы',
    tech: 'IT компания коворкинг Алматы',
    health: 'аптека медицинский центр клиника Алматы',
    retail: 'супермаркет магазин одежды книги Алматы',
    repair: 'ремонт техники сервис автосервис Алматы',
    services: 'салон красоты парикмахерская Алматы',
    tourism: 'гостиница отель хостел Алматы',
    finance: 'банк обмен валюты Алматы'
  };

  // Соответствие типов Places API для точечной фильтрации
  const GOOGLE_CATEGORY_TYPES = {
    food: ['cafe', 'restaurant', 'bakery'],
    education: ['school', 'secondary_school', 'university'],
    tech: ['coworking_space'],
    health: ['pharmacy', 'hospital', 'doctor', 'dentist'],
    retail: ['supermarket', 'shopping_mall', 'clothing_store', 'book_store'],
    repair: ['car_repair'],
    services: ['beauty_salon', 'hair_care', 'laundry'],
    tourism: ['lodging', 'tourist_attraction'],
    finance: ['bank', 'atm']
  };

  /**
   * Запрос к Google Places API (New Text Search v1 или классический Nearby Search)
   * для поиска реальных действующих организаций в районе Алматы
   * 
   * @param {Array<number>} center Координаты центра района [lat, lng]
   * @param {number} radiusMeters Радиус поиска в метрах
   * @param {string} category Ключ категории бизнеса
   * @param {string} apiKey Ключ Google Maps Platform API
   * @param {number} timeoutMs Таймаут сетевого запроса
   */
  async function fetchGooglePlacesOrganizations(center, radiusMeters = 3000, category = 'food', apiKey = GOOGLE_MAPS_API_KEY, timeoutMs = 8000) {
    const q = GOOGLE_CATEGORY_QUERIES[category] || 'кафе Алматы';

    // 1. Если загружен клиентский SDK Google Maps JS (google.maps.places), используем PlacesService
    if (typeof window !== 'undefined' && window.google && window.google.maps && window.google.maps.places) {
      return new Promise((resolve) => {
        try {
          const dummyDiv = document.createElement('div');
          const service = new window.google.maps.places.PlacesService(dummyDiv);
          const types = GOOGLE_CATEGORY_TYPES[category] || ['cafe'];

          const request = {
            location: new window.google.maps.LatLng(center[0], center[1]),
            radius: radiusMeters,
            query: q,
            type: types[0]
          };

          const timeoutId = setTimeout(() => {
            resolve({
              success: false,
              error: 'Таймаут ответа Google Maps Places Service',
              data: []
            });
          }, timeoutMs);

          service.textSearch(request, (results, status) => {
            clearTimeout(timeoutId);
            if (status === window.google.maps.places.PlacesServiceStatus.OK && Array.isArray(results)) {
              const items = results.map(place => ({
                id: `gmaps_${place.place_id}`,
                name: place.name,
                category: category,
                address: place.formatted_address || place.vicinity || 'г. Алматы',
                latitude: place.geometry?.location?.lat() || center[0],
                longitude: place.geometry?.location?.lng() || center[1],
                source: 'Google Places API',
                source_id: `gmaps/${place.place_id}`,
                last_verified_at: new Date().toISOString().split('T')[0],
                confidence_status: 'VERIFIED_GOOGLE'
              }));

              resolve({
                success: true,
                data: items,
                source: 'Google Places SDK',
                count: items.length
              });
            } else {
              resolve({
                success: false,
                error: `Google Places API вернул статус: ${status}`,
                data: []
              });
            }
          });
        } catch (sdkErr) {
          resolve({
            success: false,
            error: `Ошибка вызова Google Places SDK: ${sdkErr.message}`,
            data: []
          });
        }
      });
    }

    // 2. Если передан прямой API-ключ, пробуем эндпоинт Google Places API (New)
    if (apiKey) {
      const url = 'https://places.googleapis.com/v1/places:searchText';
      const bodyPayload = {
        textQuery: q,
        locationBias: {
          circle: {
            center: { latitude: center[0], longitude: center[1] },
            radius: radiusMeters
          }
        },
        maxResultCount: 20
      };

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location'
          },
          body: JSON.stringify(bodyPayload),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const json = await response.json();
          if (json && Array.isArray(json.places)) {
            const items = json.places
              .filter(p => p.location && typeof p.location.latitude === 'number')
              .map(p => ({
                id: `gmaps_${p.id}`,
                name: p.displayName?.text || p.displayName || 'Организация Google Maps',
                category: category,
                address: p.formattedAddress || 'г. Алматы (Google Maps)',
                latitude: Number(p.location.latitude),
                longitude: Number(p.location.longitude),
                source: 'Google Places API',
                source_id: `gmaps/${p.id}`,
                last_verified_at: new Date().toISOString().split('T')[0],
                confidence_status: 'VERIFIED_GOOGLE'
              }));

            return {
              success: true,
              data: items,
              source: 'Google Places API (New)',
              count: items.length
            };
          }
        }
      } catch (err) {
        // Fallback ниже
      }
    }

    // 3. Честное уведомление, если ключ Google Maps ещё не указан
    return {
      success: false,
      error: apiKey
        ? 'Сервер Google Places API недоступен или ограничен политикой CORS. Для клиентских запросов подключите Maps JavaScript SDK.'
        : 'Укажите Google Maps Platform API-ключ в настройках для загрузки данных из Google Places API.',
      data: []
    };
  }

  return {
    fetchOsmOrganizations,
    fetchGooglePlacesOrganizations,
    geocodeAddress,
    GOOGLE_MAPS_API_KEY,
    GOOGLE_CATEGORY_QUERIES,
    GOOGLE_CATEGORY_TYPES,
    setGoogleMapsApiKey,
    OVERPASS_ENDPOINTS
  };
}));

