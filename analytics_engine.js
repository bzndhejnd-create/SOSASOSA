/**
 * OpportunityAI — Аналитический движок геопространственного анализа и скоринга
 * 
 * Включает:
 * 1. Геодезические алгоритмы (WGS84, Haversine, Ray-Casting Point-in-Polygon)
 * 2. Конвейер очистки данных (валидация координат, дедупликация)
 * 3. Документированную математическую модель расчета привлекательности ниши
 * 4. Факторную декомпозицию (Factor Attribution) и оценку достоверности выборки
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OpportunityAnalytics = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // ==========================================================================
  // 1. Геодезические и пространственные алгоритмы
  // ==========================================================================

  /**
   * Точный расчет расстояния между двумя точками на сфере (WGS84 Haversine)
   * @param {number} lat1 Широта первой точки
   * @param {number} lon1 Долгота первой точки
   * @param {number} lat2 Широта второй точки
   * @param {number} lon2 Долгота второй точки
   * @returns {number} Расстояние в метрах
   */
  function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Радиус Земли в метрах
    const toRad = deg => (deg * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
  }

  /**
   * Проверка вхождения точки [lat, lng] в полигон GeoJSON (Ray-Casting Algorithm)
   * Поддерживает кольцо координат [[lng, lat], ...], Polygon и MultiPolygon
   * @param {number} lat Широта проверяемой точки
   * @param {number} lng Долгота проверяемой точки
   * @param {Array|Object} geomOrRing Координаты кольца или GeoJSON geometry
   * @returns {boolean} true если точка внутри
   */
  function pointInPolygon(lat, lng, geomOrRing) {
    if (!geomOrRing) return false;
    if (geomOrRing.type === 'Feature' && geomOrRing.geometry) {
      return pointInPolygon(lat, lng, geomOrRing.geometry);
    }
    if (geomOrRing.type === 'Polygon' && Array.isArray(geomOrRing.coordinates)) {
      return pointInPolygon(lat, lng, geomOrRing.coordinates[0]);
    }
    if (geomOrRing.type === 'MultiPolygon' && Array.isArray(geomOrRing.coordinates)) {
      return geomOrRing.coordinates.some(poly => pointInPolygon(lat, lng, poly[0]));
    }
    const ring = geomOrRing;
    if (!Array.isArray(ring) || ring.length < 3) return false;

    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1]; // xi = lng, yi = lat
      const xj = ring[j][0], yj = ring[j][1];

      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);

      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInGeometry(lat, lng, geometry) {
    return pointInPolygon(lat, lng, geometry);
  }

  /**
   * Проверка координат на попадание в допустимые границы города (Bounding Box)
   */
  function validateCoordinates(lat, lng, bbox) {
    if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
      return { valid: false, reason: 'Координаты не являются числами' };
    }
    if (lat < bbox.minLat || lat > bbox.maxLat || lng < bbox.minLng || lng > bbox.maxLng) {
      return {
        valid: false,
        reason: `Координаты [${lat}, ${lng}] выходят за пределы города Алматы (${bbox.minLat}–${bbox.maxLat}, ${bbox.minLng}–${bbox.maxLng})`
      };
    }
    return { valid: true };
  }

  // ==========================================================================
  // 2. Очистка и дедупликация данных
  // ==========================================================================

  /**
   * Нормализация строковых названий для сравнения
   */
  function normalizeName(name) {
    return (name || '')
      .toLowerCase()
      .replace(/["'«»–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Обнаружение и слияние дубликатов организаций
   * Критерий дубликата: расстояние < 35 метров И совпадающее нормализованное название
   */
  function deduplicatePlaces(places, distanceThresholdMeters = 35) {
    const unique = [];
    let duplicatesRemoved = 0;

    places.forEach(candidate => {
      const normCandName = normalizeName(candidate.name);
      const isDuplicate = unique.some(existing => {
        const normExistName = normalizeName(existing.name);
        const dist = haversineDistance(
          candidate.latitude, candidate.longitude,
          existing.latitude, existing.longitude
        );

        const nameMatch = normCandName.includes(normExistName) || normExistName.includes(normCandName);
        return dist <= distanceThresholdMeters && nameMatch;
      });

      if (!isDuplicate) {
        unique.push(candidate);
      } else {
        duplicatesRemoved++;
      }
    });

    return {
      places: unique,
      duplicatesRemoved
    };
  }

  // ==========================================================================
  // 3. Математическая модель аналитического скоринга
  // ==========================================================================

  /**
   * Профили весов факторов в зависимости от категории бизнеса
   * w_dem: Спрос населения
   * w_comp: Незаполненность рынка (обратная плотность конкурентов)
   * w_infra: Инфраструктурный потенциал (доходы, офисы, трафик)
   * w_risk: Риск стартового бюджета и опыта
   */
  const CATEGORY_PROFILES = {
    food: {
      label: 'Общепит и кофейни',
      w_dem: 0.25,
      w_comp: 0.35,
      w_infra: 0.30,
      w_risk: 0.10,
      minOptimalBudgetKzt: 10000000,
      targetDensityPer1000: 0.45 // Оптимальная плотность точек на 1000 чел
    },
    education: {
      label: 'Образовательные центры',
      w_dem: 0.45,
      w_comp: 0.30,
      w_infra: 0.15,
      w_risk: 0.10,
      minOptimalBudgetKzt: 6000000,
      targetDensityPer1000: 0.15
    },
    tech: {
      label: 'IT и коворкинги',
      w_dem: 0.15,
      w_comp: 0.25,
      w_infra: 0.50,
      w_risk: 0.10,
      minOptimalBudgetKzt: 20000000,
      targetDensityPer1000: 0.08
    },
    health: {
      label: 'Медицинские центры и аптеки',
      w_dem: 0.50,
      w_comp: 0.35,
      w_infra: 0.10,
      w_risk: 0.05,
      minOptimalBudgetKzt: 15000000,
      targetDensityPer1000: 0.30
    },
    retail: {
      label: 'Розничная торговля',
      w_dem: 0.35,
      w_comp: 0.35,
      w_infra: 0.20,
      w_risk: 0.10,
      minOptimalBudgetKzt: 8000000,
      targetDensityPer1000: 0.50
    },
    repair: {
      label: 'Сервисные центры и ремонт',
      w_dem: 0.30,
      w_comp: 0.35,
      w_infra: 0.25,
      w_risk: 0.10,
      minOptimalBudgetKzt: 5000000,
      targetDensityPer1000: 0.20
    },
    services: {
      label: 'Бытовые услуги и красота',
      w_dem: 0.35,
      w_comp: 0.35,
      w_infra: 0.20,
      w_risk: 0.10,
      minOptimalBudgetKzt: 7000000,
      targetDensityPer1000: 0.40
    },
    tourism: {
      label: 'Туризм и гостиницы',
      w_dem: 0.10,
      w_comp: 0.30,
      w_infra: 0.50,
      w_risk: 0.10,
      minOptimalBudgetKzt: 25000000,
      targetDensityPer1000: 0.10
    },
    finance: {
      label: 'Финансовые услуги',
      w_dem: 0.20,
      w_comp: 0.25,
      w_infra: 0.45,
      w_risk: 0.10,
      minOptimalBudgetKzt: 12000000,
      targetDensityPer1000: 0.12
    }
  };

  /**
   * Расчет прозрачного аналитического скоринга для локации
   * 
   * @param {Object} district Данные района из geo_data.js
   * @param {string} categoryKey Ключ категории бизнеса
   * @param {Array<Object>} districtPlaces Фактически верифицированные точки в этом районе
   * @param {string} budgetLevel Уровень бюджета ('low', 'medium', 'high', 'enterprise')
   * @param {string} experienceLevel Опыт основателя ('beginner', 'experienced', 'serial')
   */
  function evaluateOpportunity(district, categoryKey, districtPlaces, budgetLevel, experienceLevel) {
    const profile = CATEGORY_PROFILES[categoryKey] || CATEGORY_PROFILES.food;
    const stats = district.official_stats;

    // 1. Фильтрация прямых конкурентов в районе
    const directCompetitors = districtPlaces.filter(p => p.category === categoryKey);
    const competitorCount = directCompetitors.length;

    // Реальная плотность конкурентов (на км² урбанизированной площади)
    const competitorDensityPerKm2 = Number((competitorCount / stats.urban_area_km2).toFixed(2));
    
    // Плотность конкурентов на 1000 жителей района
    const competitorsPer1000People = Number(((competitorCount / stats.population) * 1000).toFixed(3));

    // 2. Индекс спроса S_dem (от 0 до 1)
    // Нормировка плотности населения района к базовой плотности Алматы (9000 чел/км²)
    const normPopulationDensity = Math.min(1.2, stats.population_density_per_km2 / 9000);
    const s_dem = Math.min(1.0, normPopulationDensity * 0.9);

    // 3. Индекс незаполненности рынка S_comp (от 0 до 1)
    // Чем выше плотность конкурентов относительно целевой нормы, тем ниже балл
    const saturationRatio = competitorsPer1000People / profile.targetDensityPer1000;
    let s_comp;
    if (saturationRatio <= 0.5) {
      s_comp = 0.95; // Большой дефицит предложений
    } else if (saturationRatio <= 1.0) {
      s_comp = 0.80; // Сбалансированный рынок
    } else if (saturationRatio <= 1.8) {
      s_comp = 0.55; // Плотная конкуренция
    } else {
      s_comp = 0.30; // Перенасыщенный рынок
    }

    // 4. Индекс инфраструктуры и платежеспособности S_infra (от 0 до 1)
    // Опирается на среднюю официальную зарплату района относительно средней по Алматы (480 000 ₸)
    const salaryRatio = stats.avg_monthly_salary_kzt / 480000;
    const s_infra = Math.min(1.0, Math.max(0.4, salaryRatio * 0.85));

    // 5. Оценка риска основателя и бюджета R_exp (от 0 до 1)
    let budgetPenalty = 0.2;
    if (budgetLevel === 'low') budgetPenalty = 0.6; // Высокий риск недофинансирования
    if (budgetLevel === 'medium') budgetPenalty = 0.3;
    if (budgetLevel === 'high') budgetPenalty = 0.1;
    if (budgetLevel === 'enterprise') budgetPenalty = 0.02;

    let expDiscount = 0.4;
    if (experienceLevel === 'beginner') expDiscount = 0.6;
    if (experienceLevel === 'experienced') expDiscount = 0.3;
    if (experienceLevel === 'serial') expDiscount = 0.1;

    const r_exp = (budgetPenalty * 0.65) + (expDiscount * 0.35);

    // 6. Итоговый скор по строгой математической формуле:
    // Score = 100 * (w_dem * S_dem + w_comp * S_comp + w_infra * S_infra - w_risk * R_exp)
    const factorDemScore = profile.w_dem * s_dem * 100;
    const factorCompScore = profile.w_comp * s_comp * 100;
    const factorInfraScore = profile.w_infra * s_infra * 100;
    const factorRiskPenalty = profile.w_risk * r_exp * 100;

    let rawScore = factorDemScore + factorCompScore + factorInfraScore - factorRiskPenalty;
    const finalScore = Math.max(10, Math.min(98, Math.round(rawScore)));

    // 7. Расчет достоверности (Confidence Index)
    // Учитывает объем фактической выборки подтвержденных точек в OSM
    let sampleCompleteness = Math.min(1.0, competitorCount / 6);
    let confidencePercent = Math.round((0.55 + 0.40 * sampleCompleteness) * 100);
    let confidenceNote = '';

    if (competitorCount < 3) {
      confidencePercent = Math.min(58, confidencePercent);
      confidenceNote = 'Внимание: в выбранном районе обнаружено мало подтвержденных точек этой категории в OSM. Оценка носит предварительный модельный характер.';
    } else {
      confidenceNote = `Оценка опирается на официальную демографию БНС РК и ${competitorCount} подтвержденных объектов OpenStreetMap.`;
    }

    // 8. Оценка окупаемости
    let paybackMonthsMin = 10;
    let paybackMonthsMax = 16;
    if (finalScore >= 80) {
      paybackMonthsMin = 9;
      paybackMonthsMax = 14;
    } else if (finalScore >= 65) {
      paybackMonthsMin = 13;
      paybackMonthsMax = 19;
    } else {
      paybackMonthsMin = 20;
      paybackMonthsMax = 32;
    }

    // Текстовый статус перспективы
    let perspectiveBadge = 'Умеренный баланс';
    let perspectiveClass = 'badge-mid';
    if (finalScore >= 80) {
      perspectiveBadge = 'Высокая перспективность';
      perspectiveClass = 'badge-high';
    } else if (finalScore < 60) {
      perspectiveBadge = 'Высокий риск / Насыщенный рынок';
      perspectiveClass = 'badge-low';
    }

    return {
      finalScore,
      perspectiveBadge,
      perspectiveClass,
      competitorCount,
      competitorDensityPerKm2,
      competitorsPer1000People,
      paybackRange: `${paybackMonthsMin} – ${paybackMonthsMax} мес.`,
      confidencePercent: `${confidencePercent}%`,
      confidenceNote,
      factors: {
        demandContribution: Math.round(factorDemScore),
        competitionContribution: Math.round(factorCompScore),
        infraContribution: Math.round(factorInfraScore),
        riskPenalty: Math.round(factorRiskPenalty)
      },
      formulaExplanation: `Score = round(100 × [${profile.w_dem}×${s_dem.toFixed(2)} + ${profile.w_comp}×${s_comp.toFixed(2)} + ${profile.w_infra}×${s_infra.toFixed(2)} - ${profile.w_risk}×${r_exp.toFixed(2)}])`
    };
  }

  return {
    haversineDistance,
    pointInPolygon,
    pointInGeometry,
    validateCoordinates,
    deduplicatePlaces,
    evaluateOpportunity,
    CATEGORY_PROFILES
  };
}));
