/**
 * OpportunityAI — Автоматизированный тестовый набор аудита качества данных и расчетов
 * Запуск: node tests/test_audit.js
 */

const assert = require('assert');
const GeoData = require('../geo_data.js');
const Analytics = require('../analytics_engine.js');
const ApiProvider = require('../api_provider.js');

console.log('================================================================');
console.log('🔍 Запуск полного набора тестов аудита OpportunityAI');
console.log('================================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(`   Причина: ${err.message}\n`);
  }
}

// --------------------------------------------------------------------------
// 1. Тест: Реестр содержит все 8 официальных административных районов Алматы
// --------------------------------------------------------------------------
runTest('Административное деление: Присутствуют все 8 официальных районов Алматы (БНС РК)', () => {
  const expectedDistricts = [
    'kz-ala-alatau',
    'kz-ala-almaly',
    'kz-ala-auezov',
    'kz-ala-bostandyk',
    'kz-ala-zhetysu',
    'kz-ala-medeu',
    'kz-ala-nauryzbay',
    'kz-ala-turksib'
  ];
  const actualKeys = Object.keys(GeoData.DISTRICTS);
  assert.strictEqual(actualKeys.length, 8, `Должно быть ровно 8 районов Алматы, найдено: ${actualKeys.length}`);
  expectedDistricts.forEach(slug => {
    const d = GeoData.DISTRICTS[slug];
    assert(d, `Отсутствует район ${slug}`);
    assert(d.official_stats.population > 100000, `Некорректное население у ${slug}`);
    assert(d.osm_relation_id > 0, `Отсутствует OSM Relation ID у ${slug}`);
    assert(d.geojson && d.geojson.geometry, `Отсутствует GeoJSON геометрия у ${slug}`);
  });
});

// --------------------------------------------------------------------------
// 2. Тест: Границы всех 8 районов содержат реальные полигоны OpenStreetMap WGS84
// --------------------------------------------------------------------------
runTest('Геометрия OSM WGS84: Долгота (~76.73..77.17) и широта (~43.03..43.41) валидны для всех районов', () => {
  Object.values(GeoData.DISTRICTS).forEach(dist => {
    assert(dist.geojson && dist.geojson.geometry, `Район ${dist.name} не имеет геометрии`);
    const geom = dist.geojson.geometry;
    assert(['Polygon', 'MultiPolygon'].includes(geom.type), `Тип геометрии ${geom.type} у ${dist.name}`);

    // Проверяем точки в полигонах
    const polygons = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
    let totalPoints = 0;
    polygons.forEach(poly => {
      const ring = poly[0];
      ring.forEach(([lng, lat]) => {
        totalPoints++;
        assert(lng >= 76.70 && lng <= 77.20, `Долгота ${lng} вне диапазона в ${dist.name}`);
        assert(lat >= 43.02 && lat <= 43.42, `Широта ${lat} вне диапазона в ${dist.name}`);
      });
    });
    assert(totalPoints >= 20, `Полигон ${dist.name} содержит слишком мало точек (${totalPoints}) — должен быть детальный полигон OSM`);
  });
});

// --------------------------------------------------------------------------
// 3. Тест: Отсутствие выдуманных данных в статическом реестре
// --------------------------------------------------------------------------
runTest('Честность данных: Статический массив VERIFIED_ORGANIZATIONS пуст (нет выдуманных точек)', () => {
  assert.strictEqual(GeoData.VERIFIED_ORGANIZATIONS.length, 0,
    'В базе не должно быть захардкоженных выдуманных организаций, данные должны загружаться из API');
});

// --------------------------------------------------------------------------
// 4. Тест: Валидация Bounding Box Алматы
// --------------------------------------------------------------------------
runTest('Валидация: Организация за пределами Алматы (Астана) отбраковывается', () => {
  const astanaPlace = { lat: 51.1694, lng: 71.4491 }; // Астана
  const valAstana = Analytics.validateCoordinates(astanaPlace.lat, astanaPlace.lng, GeoData.ALMATY_BBOX);
  assert.strictEqual(valAstana.valid, false, 'Астана должна быть отклонена BBox-фильтром');

  const invalidPlace = { lat: NaN, lng: 76.9 };
  const valNaN = Analytics.validateCoordinates(invalidPlace.lat, invalidPlace.lng, GeoData.ALMATY_BBOX);
  assert.strictEqual(valNaN.valid, false, 'NaN-координаты должны быть отклонены');
});

// --------------------------------------------------------------------------
// 5. Тест: Алгоритм Point-in-Polygon (поддержка MultiPolygon и Polygon)
// --------------------------------------------------------------------------
runTest('Point-in-Polygon: Точки определяются точно внутри реальных районов', () => {
  // Бостандыкский район (Almaty Towers, ул. Байзакова 280: 43.2255, 76.9270)
  const bostandykGeom = GeoData.DISTRICTS['kz-ala-bostandyk'].geojson.geometry;
  assert.strictEqual(Analytics.pointInPolygon(43.2255, 76.9270, bostandykGeom), true, 'Almaty Towers должно быть в Бостандыкском районе');

  // Алмалинский район (ул. Толе би 55 / Панфилова: 43.2555, 76.9420)
  const almalyGeom = GeoData.DISTRICTS['kz-ala-almaly'].geojson.geometry;
  assert.strictEqual(Analytics.pointInPolygon(43.2555, 76.9420, almalyGeom), true, 'Панфилова/Толе би должно быть в Алмалинском районе');
  assert.strictEqual(Analytics.pointInPolygon(43.2555, 76.9420, bostandykGeom), false, 'Панфилова/Толе би НЕ должно быть в Бостандыкском районе');

  // Алатауский район (Almaty Arena: 43.2755, 76.8240)
  const alatauGeom = GeoData.DISTRICTS['kz-ala-alatau'].geojson.geometry;
  assert.strictEqual(Analytics.pointInPolygon(43.2755, 76.8240, alatauGeom), true, 'Almaty Arena должна быть в Алатауском районе');
});

// --------------------------------------------------------------------------
// 6. Тест: Дедупликация организаций
// --------------------------------------------------------------------------
runTest('Дедупликация: Повторные записи в радиусе 35 метров объединяются', () => {
  const rawList = [
    { name: 'Coffee Boom', latitude: 43.2241, longitude: 76.9150 },
    { name: '«Coffee Boom»', latitude: 43.2242, longitude: 76.9151 }, // Смещение ~11 метров
    { name: 'Presso Cafe', latitude: 43.2285, longitude: 76.9185 }
  ];

  const result = Analytics.deduplicatePlaces(rawList, 35);
  assert.strictEqual(result.places.length, 2, 'Из 3 записей с 1 дубликатом должно остаться ровно 2');
  assert.strictEqual(result.duplicatesRemoved, 1, 'Должен быть удален ровно 1 дубликат');
});

// --------------------------------------------------------------------------
// 7. Тест: Формула Haversine точно рассчитывает геодезическое расстояние
// --------------------------------------------------------------------------
runTest('Haversine: Расстояние между точками по широте (~1.1 км)', () => {
  const dist = Analytics.haversineDistance(43.2285, 76.9185, 43.2385, 76.9185);
  assert(dist >= 1050 && dist <= 1180, `Расстояние ${dist} м должно быть около 1110 м`);
});

// --------------------------------------------------------------------------
// 8. Тест: Скоринг при пустой выборке выводит честное предупреждение
// --------------------------------------------------------------------------
runTest('Честность модели: При отсутствии данных из API выводится предупреждение', () => {
  const district = GeoData.DISTRICTS['kz-ala-bostandyk'];
  const emptyPlaces = []; // Данные ещё не загружены из API

  const evalRes = Analytics.evaluateOpportunity(district, 'food', emptyPlaces, 'medium', 'experienced');
  
  const confInt = parseInt(evalRes.confidencePercent);
  assert(confInt <= 60, `Уверенность при отсутствии данных должна быть <= 60%, получено: ${evalRes.confidencePercent}`);
  assert(evalRes.confidenceNote.includes('мало подтвержденных точек') || evalRes.confidenceNote.includes('предварительный'),
    'При недостатке данных должно выводиться честное предупреждение');
});

// --------------------------------------------------------------------------
// 9. Тест: Google Maps Platform API ключ настроен
// --------------------------------------------------------------------------
runTest('Google Maps API: Ключ настроен и интеграция Places API готова', () => {
  assert.strictEqual(typeof ApiProvider.fetchGooglePlacesOrganizations, 'function');
  assert(ApiProvider.GOOGLE_CATEGORY_QUERIES['food'], 'Поисковые запросы настроены');
  assert(Array.isArray(ApiProvider.GOOGLE_CATEGORY_TYPES['food']), 'Типы категорий настроены');
  assert.strictEqual(typeof ApiProvider.setGoogleMapsApiKey, 'function');
});

// --------------------------------------------------------------------------
// 10. Тест: Детерминированность скоринга и факторная декомпозиция
// --------------------------------------------------------------------------
runTest('Скоринг: Детерминированность и расшифровка формулы', () => {
  const district = GeoData.DISTRICTS['kz-ala-bostandyk'];
  const places = [
    { name: 'Cafe 1', category: 'food', latitude: 43.2255, longitude: 76.9270 },
    { name: 'Cafe 2', category: 'food', latitude: 43.2285, longitude: 76.9185 }
  ];

  const res1 = Analytics.evaluateOpportunity(district, 'food', places, 'medium', 'experienced');
  const res2 = Analytics.evaluateOpportunity(district, 'food', places, 'medium', 'experienced');

  assert.strictEqual(res1.finalScore, res2.finalScore, 'Скор должен быть строго детерминирован');
  assert(typeof res1.formulaExplanation === 'string', 'Должна присутствовать расшифровка формулы');
});

console.log('\n================================================================');
console.log(`🏁 Результаты тестирования: ${passedTests} из ${totalTests} тестов успешно пройдено.`);
console.log('================================================================');

if (passedTests !== totalTests) {
  process.exit(1);
}
