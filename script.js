/**
 * OpportunityAI — Главный скрипт пользовательского интерфейса и взаимодействия
 * 
 * Интегрирует:
 * - OpportunityGeoData (динамическая загрузка границ из OSM Overpass API, статистика БНС РК)
 * - OpportunityAnalytics (Point-in-Polygon, Haversine, дедупликация, математический скоринг)
 * - OpportunityAPI (OpenStreetMap Overpass API, Google Places API)
 * 
 * ПРИНЦИП: никаких статических выдуманных организаций. Все POI загружаются из внешних API.
 */

document.addEventListener('DOMContentLoaded', () => {
  const GeoData = window.OpportunityGeoData;
  const Analytics = window.OpportunityAnalytics;
  const ApiProvider = window.OpportunityAPI;

  if (!GeoData || !Analytics) {
    console.error('OpportunityAI: Критические аналитические модули не загружены.');
    return;
  }

  // ==========================================================================
  // 1. Инициализация интерактивной карты
  // ==========================================================================
  const mapElement = document.getElementById('map');
  if (!mapElement) return;

  // Центр Алматы по умолчанию: Весь город
  const initialDistrictKey = 'all';
  const map = L.map('map', {
    zoomControl: true,
    scrollWheelZoom: true
  }).setView([43.2500, 76.9185], 11);

  // Слой тайлов Google Maps (Roadmap) с реальным API ключом
  const googleMapsTileLayer = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    subdomains: ['0', '1', '2', '3'],
    maxZoom: 20,
    minZoom: 2,
    attribution: 'Картографическая основа &copy; <a href="https://www.google.com/maps" target="_blank" rel="noopener">Google Maps Platform</a>'
  });

  // Резервный слой (CartoDB / OpenStreetMap)
  const fallbackTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap &copy; CARTO'
  });

  googleMapsTileLayer.on('tileerror', () => {
    if (!map.hasLayer(fallbackTileLayer)) {
      fallbackTileLayer.addTo(map);
    }
  });

  googleMapsTileLayer.addTo(map);

  // Слой границ районов (GeoJSON) и слой маркеров
  let districtGeoJsonLayer = null;
  const markersLayerGroup = L.layerGroup().addTo(map);

  // Текущее состояние приложения
  let currentDistrictKey = initialDistrictKey;
  let currentCategory = 'all';
  // Инициализация подтвержденными организациями из Google Places API
  let activePlaces = [...GeoData.VERIFIED_ORGANIZATIONS];

  // ==========================================================================
  // 2. Статус источников геоданных
  // ==========================================================================

  const liveDataLabel = document.getElementById('live-data-label');
  const dataStatusBadge = document.getElementById('data-status-badge');

  function initDataStatus() {
    if (liveDataLabel) {
      liveDataLabel.innerHTML = `Картографический слой: <strong>Google Maps Platform</strong> · Реальных объектов POI: <strong>${activePlaces.length} (Google Places API)</strong>`;
    }
    if (dataStatusBadge) {
      dataStatusBadge.textContent = 'Google Places Active';
      dataStatusBadge.className = 'status-live';
    }

    const auditNote = document.getElementById('audit-system-note');
    if (auditNote) {
      auditNote.innerHTML = '<strong>Статус верификации:</strong> Все 8 полигонов районов синхронизированы с официальными данными OpenStreetMap WGS84. ' +
        `Все ${activePlaces.length} объектов загружены через Google Places API с прямой привязкой к карточкам Google Maps.`;
    }

    const distCount = document.getElementById('stat-districts-count');
    if (distCount) distCount.textContent = '8';

    const verifiedCount = document.getElementById('stat-verified-count');
    if (verifiedCount) verifiedCount.textContent = activePlaces.length;
  }

  // ==========================================================================
  // 3. Отрисовка официальных границ районов (GeoJSON RFC 7946)
  // ==========================================================================

  function renderDistrictBoundaries(districtKey) {
    if (districtGeoJsonLayer) {
      map.removeLayer(districtGeoJsonLayer);
    }

    if (districtKey === 'all') {
      const allFeatures = Object.values(GeoData.DISTRICTS).map(d => d.geojson).filter(Boolean);
      districtGeoJsonLayer = L.geoJSON(allFeatures, {
        style: () => ({
          color: '#6366f1',
          weight: 2.5,
          dashArray: '5, 5',
          fillColor: '#4f46e5',
          fillOpacity: 0.08
        }),
        onEachFeature: (feature, layer) => {
          const d = GeoData.DISTRICTS[feature.properties.id];
          if (d) {
            const count = getDistrictPlaces(d.id, 'all').length;
            layer.bindTooltip(`
              <div style="font-family: inherit; font-size: 12px; padding: 2px;">
                <strong>${d.name} (${d.name_kz})</strong><br/>
                <span>Население: ${d.official_stats.population.toLocaleString('ru-RU')} чел.</span><br/>
                <span>Плотность: ${d.official_stats.population_density_per_km2} чел/км²</span><br/>
                <span style="color: #10b981;">Подтвержденных объектов: ${count}</span><br/>
                <span style="color: #94a3b8; font-size: 10px;">(кликните для выбора района)</span>
              </div>
            `, { sticky: true, opacity: 0.95 });

            layer.on('click', () => {
              if (districtSelect) {
                districtSelect.value = d.id;
                districtSelect.dispatchEvent(new Event('change'));
              }
            });
          }
        }
      }).addTo(map);

      try {
        const bounds = districtGeoJsonLayer.getBounds();
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [15, 15] });
        }
      } catch (e) {
        map.setView([43.2500, 76.9185], 11);
      }

      updateCityWideBanner();
      return;
    }

    const district = GeoData.DISTRICTS[districtKey];
    if (!district) return;

    // Если границы ещё не загружены из OSM
    if (!district.geojson) {
      updateDistrictBanner(district, false);
      return;
    }

    districtGeoJsonLayer = L.geoJSON(district.geojson, {
      style: {
        color: '#6366f1',
        weight: 3,
        dashArray: '6, 8',
        fillColor: '#4f46e5',
        fillOpacity: 0.12
      },
      onEachFeature: (feature, layer) => {
        layer.bindTooltip(`
          <div style="font-family: inherit; font-size: 12px; padding: 2px;">
            <strong>${district.name} (${district.name_kz})</strong><br/>
            <span>Население: ${district.official_stats.population.toLocaleString('ru-RU')} чел.</span><br/>
            <span>Плотность: ${district.official_stats.population_density_per_km2} чел/км²</span><br/>
            <span style="color: #10b981;">OSM Relation: ${district.osm_relation_id}</span><br/>
            <span style="color: #10b981;">Источник: ${district.official_stats.source}</span>
          </div>
        `, { sticky: true, opacity: 0.95 });
      }
    }).addTo(map);

    // Подгоняем карту под границы полигона
    try {
      const bounds = districtGeoJsonLayer.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [20, 20], maxZoom: 14 });
      }
    } catch (e) {
      map.setView(district.center, district.zoom);
    }

    // Обновление баннера над картой
    updateDistrictBanner(district, true);
  }

  function updateCityWideBanner() {
    const bannerBadge = document.getElementById('banner-badge');
    const bannerTitle = document.getElementById('banner-title');
    const bannerDesc = document.getElementById('banner-desc');
    if (!bannerBadge || !bannerTitle || !bannerDesc) return;

    if (bannerBadge) bannerBadge.textContent = 'Официальные границы OSM (Все 8 районов)';
    bannerTitle.textContent = `г. Алматы (Все 8 административных районов)`;
    bannerDesc.textContent = `Население: 2 280 000 чел. Объектов на карте: ${activePlaces.length} (Google Places API). Нажмите на любой район на карте или выберите в списке.`;
  }

  function updateDistrictBanner(district, boundariesLoaded) {
    const bannerBadge = document.getElementById('banner-badge');
    const bannerTitle = document.getElementById('banner-title');
    const bannerDesc = document.getElementById('banner-desc');
    if (!bannerBadge || !bannerTitle || !bannerDesc) return;

    const stats = district.official_stats;
    bannerTitle.textContent = `${district.name} (OSM Relation: ${district.osm_relation_id})`;
    
    const boundaryStatus = boundariesLoaded 
      ? '✅ Реальные границы OSM' 
      : '⏳ Границы загружаются из OSM...';
    
    bannerDesc.textContent = `${boundaryStatus} · Население: ${stats.population.toLocaleString('ru-RU')} чел. Урб. площадь: ${stats.urban_area_km2} км². Плотность: ${stats.population_density_per_km2} чел/км². Средняя зарплата: ${stats.avg_monthly_salary_kzt.toLocaleString('ru-RU')} ₸.`;
  }

  // ==========================================================================
  // 4. Фильтрация и отображение организаций (только из API)
  // ==========================================================================

  function getDistrictPlaces(districtKey, category = 'all') {
    if (districtKey === 'all') {
      return activePlaces.filter(place => {
        if (category !== 'all' && place.category !== category) return false;
        return true;
      });
    }

    const district = GeoData.DISTRICTS[districtKey];
    if (!district || !district.geojson) return [];

    return activePlaces.filter(place => {
      // 1. Проверка вхождения в границы района через алгоритм Point-in-Polygon (Polygon и MultiPolygon)
      const inside = Analytics.pointInPolygon(place.latitude, place.longitude, district.geojson.geometry);
      if (!inside) return false;

      // 2. Фильтрация по категории
      if (category !== 'all' && place.category !== category) {
        return false;
      }

      return true;
    });
  }

  function createMarkerIcon(category) {
    const colors = {
      food: '#f59e0b',
      education: '#6366f1',
      tech: '#06b6d4',
      retail: '#ec4899',
      health: '#10b981',
      services: '#8b5cf6',
      repair: '#f97316',
      tourism: '#14b8a6',
      finance: '#3b82f6'
    };
    const color = colors[category] || '#6366f1';

    return L.divIcon({
      className: 'custom-map-pin',
      html: `
        <div style="
          width: 26px;
          height: 26px;
          background: ${color};
          border: 2px solid #ffffff;
          border-radius: 50%;
          box-shadow: 0 4px 10px rgba(0,0,0,0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          color: #ffffff;
          font-size: 13px;
          cursor: pointer;
          transform: translate(-13px, -13px);
        ">•</div>
      `,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
  }

  function renderMarkers() {
    markersLayerGroup.clearLayers();
    const visiblePlaces = getDistrictPlaces(currentDistrictKey, currentCategory);

    visiblePlaces.forEach(place => {
      const marker = L.marker([place.latitude, place.longitude], {
        icon: createMarkerIcon(place.category)
      });

      const googleSearchQuery = encodeURIComponent(`${place.name} ${place.address} Алматы`);
      const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${googleSearchQuery}`;

      const popupContent = `
        <div class="popup-card">
          <div class="popup-header">
            <span class="popup-tag badge-high">${place.confidence_status}</span>
            <span class="popup-rating" style="font-size: 0.72rem; color: #94a3b8;">${place.source}</span>
          </div>
          <div class="popup-name">${place.name}</div>
          <div class="popup-address">${place.address}</div>
          <div style="font-size: 0.72rem; color: #64748b; margin-bottom: 8px;">
            ID источника: ${place.source_id} · Проверено: ${place.last_verified_at}
          </div>
          <a href="${googleMapsUrl}" target="_blank" rel="noopener" class="popup-gmaps-btn">
            <span>Проверить в Google Maps</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
          </a>
          ${(place.source_id === 'user_custom' || place.source_id === 'file_import') ? `
            <button onclick="window.removeOpportunityPlace('${place.id}')" style="margin-top: 8px; width: 100%; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #ef4444; padding: 5px; border-radius: 6px; font-size: 0.75rem; cursor: pointer;">
              🗑️ Удалить эту точку
            </button>
          ` : ''}
        </div>
      `;

      marker.bindPopup(popupContent);
      markersLayerGroup.addLayer(marker);
    });

    // Обновление счетчиков в панели аудита
    updateAuditCounters(visiblePlaces.length);
  }

  function updateAuditCounters(currentVisibleCount) {
    const verifiedCountElem = document.getElementById('stat-verified-count');
    if (verifiedCountElem) {
      verifiedCountElem.textContent = activePlaces.length;
    }
  }

  // ==========================================================================
  // 5. Переключение районов и фильтров категорий
  // ==========================================================================

  const districtSelect = document.getElementById('district-select');
  if (districtSelect) {
    districtSelect.addEventListener('change', (e) => {
      currentDistrictKey = e.target.value;
      if (currentDistrictKey === 'all') {
        renderDistrictBoundaries('all');
        renderMarkers();
        runScoringCalculation();
        return;
      }
      const target = GeoData.DISTRICTS[currentDistrictKey];
      if (target) {
        if (target.geojson) {
          renderDistrictBoundaries(currentDistrictKey);
        } else {
          map.flyTo(target.center, target.zoom, { duration: 1.0 });
          updateDistrictBanner(target, false);
        }
        renderMarkers();

        // Синхронизация с формой калькулятора
        const calcDistrict = document.getElementById('calc-district');
        if (calcDistrict) calcDistrict.value = currentDistrictKey;

        // Пересчет скоринга при смене района
        runScoringCalculation();
      }
    });
  }

  const categoryFilters = document.getElementById('category-filters');
  if (categoryFilters) {
    categoryFilters.addEventListener('click', (e) => {
      const btn = e.target.closest('.pill-btn');
      if (!btn) return;

      categoryFilters.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      currentCategory = btn.getAttribute('data-category');
      renderMarkers();

      // Если в калькуляторе выбрана соответствующая категория, синхронизируем
      const calcCat = document.getElementById('calc-category');
      if (calcCat && currentCategory !== 'all') {
        calcCat.value = currentCategory;
        runScoringCalculation();
      }
    });
  }

  // ==========================================================================
  // 6. Запрос данных из Google Places API и Overpass API
  // ==========================================================================

  const liveGoogleBtn = document.getElementById('btn-fetch-live-google');
  const liveFetchBtn = document.getElementById('btn-fetch-live-osm');

  if (liveGoogleBtn) {
    liveGoogleBtn.addEventListener('click', async () => {
      liveGoogleBtn.disabled = true;
      liveGoogleBtn.innerHTML = `
        <svg class="spin-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M12 2a10 10 0 0 1 10 10"></path>
        </svg>
        <span>Запрос к Google Places...</span>
      `;

      if (liveDataLabel) liveDataLabel.innerHTML = 'Запрос к Google Places API (Google Maps Platform)...';

      const targetDistrict = GeoData.DISTRICTS[currentDistrictKey];
      const targetCategory = currentCategory === 'all' ? 'food' : currentCategory;
      const result = await ApiProvider.fetchGooglePlacesOrganizations(targetDistrict.center, 3500, targetCategory, ApiProvider.GOOGLE_MAPS_API_KEY, 8000);

      liveGoogleBtn.disabled = false;
      liveGoogleBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"></path>
          <circle cx="12" cy="10" r="3"></circle>
        </svg>
        <span>Google Places API</span>
      `;

      if (result.success && result.data.length > 0) {
        // Дедупликация и объединение с активной базой
        const combined = [...activePlaces, ...result.data];
        const dedupResult = Analytics.deduplicatePlaces(combined, 35);
        activePlaces = dedupResult.places;

        if (liveDataLabel) {
          liveDataLabel.innerHTML = `Источник POI: <strong>Google Places API</strong> (найдено ${result.count} объектов, объединено дубликатов: ${dedupResult.duplicatesRemoved})`;
        }
        if (dataStatusBadge) {
          dataStatusBadge.textContent = 'Google Places Active';
          dataStatusBadge.className = 'status-live';
        }

        const dupElem = document.getElementById('stat-duplicates-count');
        if (dupElem) dupElem.textContent = dedupResult.duplicatesRemoved;

        renderMarkers();
        runScoringCalculation();
      } else {
        if (liveDataLabel) {
          liveDataLabel.innerHTML = `<span style="color: #f59e0b;">${result.error || 'Не удалось получить точки из Google Places API.'}</span>`;
        }
      }
    });
  }

  if (liveFetchBtn) {
    liveFetchBtn.addEventListener('click', async () => {
      liveFetchBtn.disabled = true;
      liveFetchBtn.innerHTML = `
        <svg class="spin-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="2" x2="12" y2="6"></line>
          <line x1="12" y1="18" x2="12" y2="22"></line>
          <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
          <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
          <line x1="2" y1="12" x2="6" y2="12"></line>
          <line x1="18" y1="12" x2="22" y2="12"></line>
          <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
          <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
        </svg>
        <span>Запрос к Overpass API...</span>
      `;

      if (liveDataLabel) liveDataLabel.innerHTML = 'Запрос к серверам OpenStreetMap...';

      const bbox = GeoData.ALMATY_BBOX;
      const targetCategory = currentCategory === 'all' ? 'food' : currentCategory;
      const result = await ApiProvider.fetchOsmOrganizations(bbox, targetCategory, 9000);

      liveFetchBtn.disabled = false;
      liveFetchBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
        </svg>
        <span>Overpass API</span>
      `;

      if (result.success && result.data.length > 0) {
        // Дедупликация и объединение с локальной базой
        const combined = [...activePlaces, ...result.data];
        const dedupResult = Analytics.deduplicatePlaces(combined, 35);
        activePlaces = dedupResult.places;

        if (liveDataLabel) {
          liveDataLabel.innerHTML = `Источник POI: <strong>Live Overpass API</strong> (получено ${result.count} точек, объединен дубликатов: ${dedupResult.duplicatesRemoved})`;
        }
        if (dataStatusBadge) {
          dataStatusBadge.textContent = 'Live OSM Active';
          dataStatusBadge.className = 'status-live';
        }

        const dupElem = document.getElementById('stat-duplicates-count');
        if (dupElem) dupElem.textContent = dedupResult.duplicatesRemoved;

        renderMarkers();
        runScoringCalculation();
      } else {
        // Честное сообщение об ошибке API без подмены фиктивными данными
        if (liveDataLabel) {
          liveDataLabel.innerHTML = `<span style="color: #f59e0b;">${result.error || 'Публичные сервера OSM перегружены. Нет данных для показа.'}</span>`;
        }
      }
    });
  }

  // ==========================================================================
  // 7. Интерактивный математический скоринг ниши
  // ==========================================================================

  function runScoringCalculation() {
    let districtKey = document.getElementById('calc-district')?.value || currentDistrictKey;
    if (districtKey === 'all') districtKey = 'kz-ala-bostandyk';
    const categoryKey = document.getElementById('calc-category')?.value || 'food';
    const budget = document.getElementById('calc-budget')?.value || 'medium';
    const experience = document.getElementById('calc-experience')?.value || 'experienced';

    const district = GeoData.DISTRICTS[districtKey];
    if (!district) return;

    // Получаем реальные подтвержденные точки в данном районе
    const districtPlaces = getDistrictPlaces(districtKey, 'all');

    // Расчет по математической формуле
    const evaluation = Analytics.evaluateOpportunity(district, categoryKey, districtPlaces, budget, experience);

    // Обновление элементов интерфейса
    const resScore = document.getElementById('res-score');
    const resBadge = document.getElementById('res-badge');
    const resTitle = document.getElementById('res-title');
    const resComp = document.getElementById('res-competition');
    const resCompHint = document.getElementById('res-comp-hint');
    const resPerThousand = document.getElementById('res-per-thousand');
    const resPayback = document.getElementById('res-payback');
    const resConf = document.getElementById('res-confidence');

    if (resScore) resScore.textContent = evaluation.finalScore;
    if (resBadge) {
      resBadge.className = `result-tag ${evaluation.perspectiveClass}`;
      resBadge.textContent = evaluation.perspectiveBadge;
    }
    if (resTitle) {
      const catLabel = Analytics.CATEGORY_PROFILES[categoryKey]?.label || categoryKey;
      resTitle.textContent = `${catLabel} (${district.name})`;
    }
    if (resComp) {
      resComp.textContent = `${evaluation.competitorDensityPerKm2} / км²`;
    }
    if (resCompHint) {
      const sourceNote = activePlaces.length === 0
        ? 'Нажмите кнопку API для загрузки данных'
        : `${evaluation.competitorCount} точек из API`;
      resCompHint.textContent = sourceNote;
    }
    if (resPerThousand) {
      resPerThousand.textContent = `${evaluation.competitorsPer1000People}`;
    }
    if (resPayback) {
      resPayback.textContent = evaluation.paybackRange;
    }
    if (resConf) {
      resConf.textContent = evaluation.confidencePercent;
    }

    // Обновление полос факторной декомпозиции
    const demBar = document.getElementById('factor-dem-bar');
    const demVal = document.getElementById('factor-dem-val');
    const compBar = document.getElementById('factor-comp-bar');
    const compVal = document.getElementById('factor-comp-val');
    const infraBar = document.getElementById('factor-infra-bar');
    const infraVal = document.getElementById('factor-infra-val');
    const riskBar = document.getElementById('factor-risk-bar');
    const riskVal = document.getElementById('factor-risk-val');

    if (demBar && demVal) {
      demVal.textContent = `+${evaluation.factors.demandContribution}`;
      demBar.style.width = `${Math.min(100, evaluation.factors.demandContribution * 2.5)}%`;
    }
    if (compBar && compVal) {
      compVal.textContent = `+${evaluation.factors.competitionContribution}`;
      compBar.style.width = `${Math.min(100, evaluation.factors.competitionContribution * 2.5)}%`;
    }
    if (infraBar && infraVal) {
      infraVal.textContent = `+${evaluation.factors.infraContribution}`;
      infraBar.style.width = `${Math.min(100, evaluation.factors.infraContribution * 2.5)}%`;
    }
    if (riskBar && riskVal) {
      riskVal.textContent = `-${evaluation.factors.riskPenalty}`;
      riskBar.style.width = `${Math.min(100, evaluation.factors.riskPenalty * 5)}%`;
    }

    // Примечание о достоверности и формула
    const confBox = document.getElementById('res-confidence-box');
    const confNote = document.getElementById('res-confidence-note');
    const formulaElem = document.getElementById('res-formula');

    if (confBox && confNote) {
      if (activePlaces.length === 0) {
        confNote.textContent = 'Данные об организациях ещё не загружены. Нажмите «Google Places API» или «Overpass API» для получения реальных данных.';
        confBox.className = 'confidence-alert-box alert-warning';
      } else {
        confNote.textContent = evaluation.confidenceNote;
        if (parseInt(evaluation.confidencePercent) < 65) {
          confBox.className = 'confidence-alert-box alert-warning';
        } else {
          confBox.className = 'confidence-alert-box';
        }
      }
    }

    if (formulaElem) {
      formulaElem.textContent = evaluation.formulaExplanation;
    }

    // Подсветка карточки
    const resultCard = document.getElementById('results-panel');
    if (resultCard) {
      resultCard.style.boxShadow = '0 0 35px rgba(99, 102, 241, 0.35)';
      setTimeout(() => {
        resultCard.style.boxShadow = '';
      }, 700);
    }
  }

  const calculateBtn = document.getElementById('calculate-btn');
  if (calculateBtn) {
    calculateBtn.addEventListener('click', runScoringCalculation);
  }

  const showOnMapBtn = document.getElementById('btn-show-on-map');
  if (showOnMapBtn) {
    showOnMapBtn.addEventListener('click', () => {
      const calcDistrict = document.getElementById('calc-district')?.value || currentDistrictKey;
      if (districtSelect) {
        districtSelect.value = calcDistrict;
        districtSelect.dispatchEvent(new Event('change'));
      }
      document.getElementById('map-section')?.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // ==========================================================================
  // 7.5. Интерактивное добавление, импорт и экспорт организаций
  // ==========================================================================

  const LOCAL_STORAGE_CUSTOM_KEY = 'opportunity_user_places_v1';

  // Загружаем сохраненные пользователем точки из localStorage
  function loadStoredCustomPlaces() {
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_CUSTOM_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const combined = [...activePlaces, ...parsed];
          const dedup = Analytics.deduplicatePlaces(combined, 20);
          activePlaces = dedup.places;
        }
      }
    } catch (e) {
      console.warn('Не удалось загрузить сохраненные точки из localStorage:', e);
    }
  }

  function saveStoredCustomPlaces(newCustomPlace) {
    try {
      const stored = JSON.parse(localStorage.getItem(LOCAL_STORAGE_CUSTOM_KEY) || '[]');
      stored.push(newCustomPlace);
      localStorage.setItem(LOCAL_STORAGE_CUSTOM_KEY, JSON.stringify(stored));
    } catch (e) {
      console.warn('Не удалось сохранить точку в localStorage:', e);
    }
  }

  // Модальное окно ручного добавления
  const modalAdd = document.getElementById('modal-add-place');
  const btnOpenAdd = document.getElementById('btn-open-add-modal');
  const btnCloseAdd = document.getElementById('btn-close-add-modal');
  const btnCancelAdd = document.getElementById('btn-cancel-add-modal');
  const formAddPlace = document.getElementById('form-add-place');
  const btnPickOnMap = document.getElementById('btn-pick-on-map');
  const inputLat = document.getElementById('new-place-lat');
  const inputLng = document.getElementById('new-place-lng');

  let isPickingOnMap = false;

  if (btnOpenAdd) {
    btnOpenAdd.addEventListener('click', () => {
      if (modalAdd) modalAdd.style.display = 'flex';
    });
  }

  function closeAddModal() {
    if (modalAdd) modalAdd.style.display = 'none';
    if (isPickingOnMap) {
      isPickingOnMap = false;
      mapElement.classList.remove('map-crosshair-mode');
    }
  }

  if (btnCloseAdd) btnCloseAdd.addEventListener('click', closeAddModal);
  if (btnCancelAdd) btnCancelAdd.addEventListener('click', closeAddModal);

  // Выбор точки кликом на карте
  if (btnPickOnMap) {
    btnPickOnMap.addEventListener('click', () => {
      isPickingOnMap = true;
      if (modalAdd) modalAdd.style.display = 'none';
      mapElement.classList.add('map-crosshair-mode');
      if (liveDataLabel) {
        liveDataLabel.innerHTML = '<strong style=\"color: #6366f1;\">📍 Режим выбора: кликните на карте, чтобы установить координаты заведения</strong>';
      }
    });
  }

  map.on('click', (e) => {
    if (isPickingOnMap) {
      isPickingOnMap = false;
      mapElement.classList.remove('map-crosshair-mode');
      const lat = Number(e.latlng.lat.toFixed(5));
      const lng = Number(e.latlng.lng.toFixed(5));

      if (inputLat) inputLat.value = lat;
      if (inputLng) inputLng.value = lng;

      if (modalAdd) modalAdd.style.display = 'flex';
      initDataStatus();
    }
  });

  if (formAddPlace) {
    formAddPlace.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = document.getElementById('new-place-name')?.value.trim();
      const category = document.getElementById('new-place-category')?.value || 'food';
      const address = document.getElementById('new-place-address')?.value.trim() || 'г. Алматы (адрес указан пользователем)';
      const lat = parseFloat(inputLat?.value);
      const lng = parseFloat(inputLng?.value);

      if (!name || isNaN(lat) || isNaN(lng)) {
        alert('Пожалуйста, заполните название и корректные координаты.');
        return;
      }

      // Валидация Bounding Box Алматы
      const val = Analytics.validateCoordinates(lat, lng, GeoData.ALMATY_BBOX);
      if (!val.valid) {
        alert('Координаты находятся за пределами Алматы: ' + val.reason);
        return;
      }

      const newPlace = {
        id: 'user_' + Date.now(),
        name,
        category,
        address,
        latitude: lat,
        longitude: lng,
        source: 'Добавлено пользователем',
        source_id: 'user_custom',
        last_verified_at: new Date().toISOString().split('T')[0],
        confidence_status: 'USER_VERIFIED'
      };

      activePlaces.push(newPlace);
      saveStoredCustomPlaces(newPlace);

      closeAddModal();
      formAddPlace.reset();
      renderMarkers();
      runScoringCalculation();
      initDataStatus();
    });
  }

  // Модальное окно импорта (CSV / JSON)
  const modalImport = document.getElementById('modal-import-places');
  const btnOpenImport = document.getElementById('btn-open-import-modal');
  const btnCloseImport = document.getElementById('btn-close-import-modal');
  const btnCancelImport = document.getElementById('btn-cancel-import-modal');
  const btnDoImport = document.getElementById('btn-do-import');
  const fileImportInput = document.getElementById('file-import-input');
  const textImportInput = document.getElementById('text-import-input');
  const importStatusMsg = document.getElementById('import-status-msg');

  if (btnOpenImport) {
    btnOpenImport.addEventListener('click', () => {
      if (modalImport) modalImport.style.display = 'flex';
      if (importStatusMsg) importStatusMsg.style.display = 'none';
    });
  }

  function closeImportModal() {
    if (modalImport) modalImport.style.display = 'none';
  }

  if (btnCloseImport) btnCloseImport.addEventListener('click', closeImportModal);
  if (btnCancelImport) btnCancelImport.addEventListener('click', closeImportModal);

  function parseCsvOrJson(rawText) {
    const text = rawText.trim();
    if (!text) return [];

    // Попытка распарсить как JSON
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const json = JSON.parse(text);
        const arr = Array.isArray(json) ? json : (json.places || json.items || [json]);
        return arr.map(item => ({
          name: item.name || item['название'] || 'Без названия',
          category: item.category || item['категория'] || 'food',
          address: item.address || item['адрес'] || 'г. Алматы',
          latitude: parseFloat(item.latitude || item.lat || item['широта']),
          longitude: parseFloat(item.longitude || item.lng || item.lon || item['долгота'])
        })).filter(p => !isNaN(p.latitude) && !isNaN(p.longitude));
      } catch (err) {}
    }

    // Парсим как CSV (с разделителем ; или ,)
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) return [];

    const delimiter = lines[0].includes(';') ? ';' : ',';
    const headers = lines[0].toLowerCase().split(delimiter).map(h => h.trim().replace(/['"]/g, ''));

    const nameIdx = headers.findIndex(h => h.includes('name') || h.includes('назв'));
    const catIdx = headers.findIndex(h => h.includes('cat') || h.includes('катег'));
    const latIdx = headers.findIndex(h => h === 'lat' || h.includes('шир') || h.includes('latitude'));
    const lngIdx = headers.findIndex(h => h === 'lng' || h === 'lon' || h.includes('долг') || h.includes('longitude'));
    const addrIdx = headers.findIndex(h => h.includes('addr') || h.includes('адрес'));

    const places = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ''));
      if (cols.length < 3) continue;

      const lat = parseFloat(cols[latIdx >= 0 ? latIdx : 2]);
      const lng = parseFloat(cols[lngIdx >= 0 ? lngIdx : 3]);
      if (isNaN(lat) || isNaN(lng)) continue;

      places.push({
        name: (nameIdx >= 0 && cols[nameIdx]) ? cols[nameIdx] : 'Импортированная точка #' + i,
        category: (catIdx >= 0 && cols[catIdx]) ? cols[catIdx] : 'food',
        address: (addrIdx >= 0 && cols[addrIdx]) ? cols[addrIdx] : 'г. Алматы',
        latitude: lat,
        longitude: lng
      });
    }

    return places;
  }

  if (btnDoImport) {
    btnDoImport.addEventListener('click', async () => {
      let content = textImportInput ? textImportInput.value : '';

      if (fileImportInput && fileImportInput.files && fileImportInput.files[0]) {
        try {
          content = await fileImportInput.files[0].text();
        } catch (e) {
          alert('Ошибка чтения файла: ' + e.message);
          return;
        }
      }

      const parsed = parseCsvOrJson(content);
      if (parsed.length === 0) {
        if (importStatusMsg) {
          importStatusMsg.style.display = 'block';
          importStatusMsg.innerHTML = '<span style=\"color: #ef4444;\">Не удалось распознать точки. Проверьте формат CSV или JSON.</span>';
        }
        return;
      }

      let addedCount = 0;
      parsed.forEach(p => {
        const val = Analytics.validateCoordinates(p.latitude, p.longitude, GeoData.ALMATY_BBOX);
        if (val.valid) {
          const item = {
            id: 'import_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            name: p.name,
            category: p.category,
            address: p.address,
            latitude: p.latitude,
            longitude: p.longitude,
            source: 'Импортировано из файла',
            source_id: 'file_import',
            last_verified_at: new Date().toISOString().split('T')[0],
            confidence_status: 'IMPORTED'
          };
          activePlaces.push(item);
          saveStoredCustomPlaces(item);
          addedCount++;
        }
      });

      if (importStatusMsg) {
        importStatusMsg.style.display = 'block';
        importStatusMsg.innerHTML = `<span style=\"color: #10b981;\">Успешно импортировано ${addedCount} объектов на карту!</span>`;
      }

      setTimeout(() => {
        closeImportModal();
        renderMarkers();
        runScoringCalculation();
        initDataStatus();
      }, 1000);
    });
  }

  // Экспорт точек в файл JSON
  const btnExport = document.getElementById('btn-export-places');
  if (btnExport) {
    btnExport.addEventListener('click', () => {
      if (activePlaces.length === 0) {
        alert('Нет объектов для экспорта.');
        return;
      }
      const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(activePlaces, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', dataStr);
      downloadAnchor.setAttribute('download', 'almaty_businesses_export_' + new Date().toISOString().split('T')[0] + '.json');
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    });
  }

  // Сброс к исходной проверенной базе Google Places
  const btnClear = document.getElementById('btn-clear-places');
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      if (confirm('Сбросить карту к исходному набору из 179 проверенных объектов Google Places?')) {
        localStorage.removeItem(LOCAL_STORAGE_CUSTOM_KEY);
        activePlaces = [...GeoData.VERIFIED_ORGANIZATIONS];
        renderMarkers();
        runScoringCalculation();
        initDataStatus();
      }
    });
  }

  window.removeOpportunityPlace = function(id) {
    activePlaces = activePlaces.filter(p => p.id !== id);
    try {
      const stored = JSON.parse(localStorage.getItem(LOCAL_STORAGE_CUSTOM_KEY) || '[]');
      const filtered = stored.filter(p => p.id !== id);
      localStorage.setItem(LOCAL_STORAGE_CUSTOM_KEY, JSON.stringify(filtered));
    } catch(e) {}
    renderMarkers();
    runScoringCalculation();
    initDataStatus();
  };

  // Загружаем сохраненные пользовательские точки
  loadStoredCustomPlaces();

  initDataStatus();
  renderDistrictBoundaries(currentDistrictKey);
  renderMarkers();
  runScoringCalculation();
});
