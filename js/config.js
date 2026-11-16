/* Soleil du jour – réglages par défaut.
   Ce fichier ne contient AUCUNE adresse personnelle : seulement le centre du village.
   Vos vrais réglages (adresse, coordonnées, appareils…) sont enregistrés uniquement sur votre téléphone.
   Calage du 16/11/2026 sur 106 jours de relevés Atmozen, du 1/08 au 14/11/2026 (voir CALAGE.md). */
var SDJ_DEFAULTS = {
  version: 3,
  site: {
    label: 'Champanges (centre du village)',
    lat: 46.37, lon: 6.55,
    /* Relief vu depuis le village (PVGIS, Commission européenne), hauteur en degrés tous les 7,5° d'azimut, de -180 (nord) à 180 (nord) en passant par -90 (est), 0 (sud), 90 (ouest). */
    horizon: [0.8,0.4,1.5,1.5,1.5,4.6,4.6,4.6,4.6,4.6,4.6,4.6,4.6,5.7,5.0,4.6,4.6,4.6,5.7,4.6,3.8,5.7,6.5,5.3,6.1,6.5,5.7,3.4,3.1,1.5,1.5,0.0,0.0,0.4,0.8,1.1,0.8,1.1,0.8,1.1,1.1,1.1,1.5,1.5,1.1,0.8,0.8,0.8,0.8]
  },
  pv: {
    kwE: 4.5, kwW: 4.5, tilt: 31,
    azE: -90, azW: 90,          /* -90 = plein est, 90 = plein ouest, 0 = sud */
    cap: 8,                     /* limite des onduleurs (kW) */
    pr: 0.92,                   /* coefficient de calage (57 jours ensoleillés, août-novembre 2026) */
    albedo: 0.2, gamma: -0.0035, kTemp: 0.035,
    /* calés sur les jours ensoleillés d'août à novembre, la courbe du 14/11 (pic vers 14h) et le 8/08 (faible jusqu'à 10h) */
    obstacles: [
      { n: 'Bâtiment au sud-est (partie haute)', az1: -130, az2: -60, h: 40 },
      { n: 'Bâtiment au sud-est (partie basse)', az1: -60, az2: -25, h: 20 },
      { n: 'Masque au sud (soleil d’hiver)', az1: -25, az2: 15, h: 30 },
      { n: 'Masque bas à l’ouest-sud-ouest', az1: 40, az2: 80, h: 11 }
    ],
    /* heures sans soleil : brouillard / stratus (nuages bas ≥ 90 %, pas de pluie) et autres temps couverts */
    grey: { stratus: 0.2, overcast: 0.8 }
  },
  base: 0.3,                    /* consommation de fond de la maison (kW) */
  leave: '05:45',
  /* mode : 'differe' = départ différé, 'fin' = fin différée, 'main' = à lancer à la main, 'non' = non pilotable
     kwh : énergie d'un cycle ; d : durée (h) ; p : puissance max (kW, pour info) ; a / b : pas avant / fini avant (h) ;
     step : pas du minuteur (h) ; maxDelay : différé maximum (h) ; after : ne démarre qu'après la fin de cet appareil */
  apps: [
    { id: 'lv',   n: 'Lave-vaisselle', p: 2.4, kwh: 1.0, d: 3,   mode: 'differe', step: 1, maxDelay: 24, a: 6, b: 20, on: true },
    { id: 'll',   n: 'Lave-linge',     p: 2.4, kwh: 0.9, d: 2,   mode: 'differe', step: 1, maxDelay: 24, a: 6, b: 20, on: true },
    { id: 'sl',   n: 'Sèche-linge',    p: 1.1, kwh: 1.5, d: 1.5, mode: 'main',    step: 1, maxDelay: 24, a: 6, b: 20, on: false, after: 'll' },
    { id: 'four', n: 'Four',           p: 3.6, kwh: 1.5, d: 1,   mode: 'main',    step: 1, maxDelay: 0,  a: 8, b: 20, on: false },
    { id: 'ecs',  n: 'Ballon 300 L (secours électrique)', p: 6, kwh: 6, d: 1, mode: 'non', step: 1, maxDelay: 0, a: 8, b: 20, on: false }
  ]
};
