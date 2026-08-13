/**
 * DELTA — Shared Location & Service Utilities
 * ============================================================
 * Common functions previously duplicated across index.html, media-feed.html,
 * bazaar.html, discover-people.html, and media-profile.html. Loading this
 * ONE file on every page means a fix here now applies everywhere at once —
 * no more risk of fixing something in index.html and forgetting the same
 * fix in media-feed.html (which happened repeatedly during Location
 * Architecture v1 development).
 *
 * REQUIREMENTS FOR THE PAGE INCLUDING THIS FILE
 * ------------------------------------------------------------
 * These functions expect the following globals to exist by the time they
 * are actually CALLED (not necessarily at page-load time, since these are
 * just function declarations until invoked):
 *   - db    : firebase.firestore() instance
 *   - auth  : firebase.auth() instance
 * Nothing else is required — CITY, currentUser etc. are NOT referenced
 * here; callers pass in whatever city/text they need resolved.
 *
 * LOAD ORDER
 * ------------------------------------------------------------
 * Include this AFTER the Firebase SDK <script> tags but it does not
 * strictly need to load after firebase.initializeApp() runs, since nothing
 * in this file touches `db`/`auth` until a function is actually called
 * (which always happens later, after user interaction).
 *
 *   <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
 *   <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>
 *   <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-firestore.js"></script>
 *   <script src="delta-shared.js"></script>   ← add this line
 */

// ── In-memory + sessionStorage cache for cityConfig lookups ──
var _cityGeoCache = {};
var CM_CACHE_TTL_MS = 8 * 60 * 1000; // 8 minutes — short enough that an Admin's
  // service-status change shows up quickly, long enough to meaningfully cut
  // down repeated Firestore reads across page navigations in the same session.

// Known-city fallback data, used only if a live cityConfig fetch fails
// entirely (offline, etc.) — never the primary source of truth, which is
// always the Firestore cityConfig collection (self-healing, see getCityGeo).
var CITY_GEO_SEED_DEFAULTS = {
  manteswar: {label:'Manteswar', district:'Purba Bardhaman', state:'West Bengal', country:'India', pincodes:['713145','713422'], geoBoundary:{centerLat:23.4225, centerLng:88.1075, radiusKm:15}},
  memari: {label:'Memari', district:'Purba Bardhaman', state:'West Bengal', country:'India', pincodes:['713146'], geoBoundary:{centerLat:23.176, centerLng:88.107, radiusKm:15}}
};

function _cmCacheRead(key){
  try{
    var raw = sessionStorage.getItem(key);
    if(!raw) return null;
    var parsed = JSON.parse(raw);
    if(Date.now() - parsed.t > CM_CACHE_TTL_MS) return null;
    return parsed.v;
  }catch(e){ return null; }
}
function _cmCacheWrite(key, value){
  try{ sessionStorage.setItem(key, JSON.stringify({v:value, t:Date.now()})); }catch(e){}
}

/**
 * Looks up a city's full geo/config record from Firestore (cityConfig
 * collection), with caching and a graceful in-memory fallback. If a
 * logged-in user requests a city that has no cityConfig doc yet, this
 * self-heals by creating one from the fallback data — this is intentional
 * for genuine DELTA-operated cities (e.g. a fresh Manteswar/Memari record),
 * but callers resolving an ARBITRARY geocoded place name (not meant to
 * become a real DELTA city) should avoid calling this for display purposes
 * — use the areaLabel captured at registration time instead, to avoid
 * cluttering cityConfig with one-off place names.
 */
async function getCityGeo(city){
  if(_cityGeoCache[city]) return _cityGeoCache[city];
  var cached = _cmCacheRead('cm_city_'+city);
  if(cached){ _cityGeoCache[city] = cached; return cached; }
  var fallback = CITY_GEO_SEED_DEFAULTS[city] || {label:city, district:'', state:'', country:'India', pincodes:[]};
  try{
    var doc = await db.collection('cityConfig').doc(city).get();
    if(doc.exists){ _cityGeoCache[city] = doc.data(); _cmCacheWrite('cm_city_'+city, doc.data()); return doc.data(); }
    if(auth.currentUser){
      try{ await db.collection('cityConfig').doc(city).set(fallback); }
      catch(e){ console.warn('cityConfig self-heal skipped', e); }
    }
    _cityGeoCache[city] = fallback;
    _cmCacheWrite('cm_city_'+city, fallback);
    return fallback;
  }catch(e){
    console.warn('cityConfig fetch failed, using in-memory default', e);
    return fallback;
  }
}

// ── Service-availability resolver — checks the platform-wide override FIRST
// (City Management "Platform-wide Service Status"), then falls back to the
// city's own per-service status. A platform-level OFF always wins, so a
// single maintenance toggle takes every city down for that service at
// once, without touching each city's individual config. ──
var _platformConfigCache = null;
async function getServiceStatus(cityId, serviceKey){
  if(_platformConfigCache === null){
    var cachedPlatform = _cmCacheRead('cm_platform');
    if(cachedPlatform){ _platformConfigCache = cachedPlatform; }
    else{
      try{
        var pDoc = await db.collection('platformConfig').doc('global').get();
        _platformConfigCache = pDoc.exists ? (pDoc.data().services||{}) : {};
        _cmCacheWrite('cm_platform', _platformConfigCache);
      }catch(e){ console.warn('platformConfig fetch failed', e); _platformConfigCache = {}; }
    }
  }
  var platformEntry = _platformConfigCache[serviceKey];
  if(platformEntry && platformEntry.status !== 'active') return platformEntry.status; // platform override wins

  var geo = await getCityGeo(cityId);
  var cityEntry = (geo.services && geo.services[serviceKey]) || {status:'disabled'};
  return cityEntry.status;
}
// Convenience — most callers just want a yes/no answer for gating a button.
async function isServiceActive(cityId, serviceKey){
  return (await getServiceStatus(cityId, serviceKey)) === 'active';
}

/**
 * Resolves free-typed text to just a pincode (used by the simpler
 * pincode-only check flows). For full geo info (district/state/country/
 * city slug), use resolveTextToFullGeo instead.
 */
function resolveTextToPincode(text){
  return new Promise(function(resolve){
    if(typeof google==='undefined' || !google.maps || !google.maps.Geocoder){
      resolve(null); return;
    }
    var geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address: text }, function(results, status){
      if(status !== 'OK' || !results || !results.length){ resolve(null); return; }
      var comps = results[0].address_components || [];
      for(var i=0;i<comps.length;i++){
        if(comps[i].types.indexOf('postal_code') >= 0){ resolve(comps[i].long_name); return; }
      }
      resolve(null);
    });
  });
}

// Fuller geocoding — extracts a human-readable area label, a real city
// name + normalized slug (used as homeCity — this holds the ACTUAL place
// name, e.g. 'kolkata', not null), plus district/state/country. Whether
// DELTA actually operates there is a SEPARATE question, answered by
// whether a cityConfig doc exists for this slug (checked at service-gate
// time via getServiceStatus(), which already treats "no cityConfig doc" as
// all-services-disabled) — homeCity itself is just an honest fact about
// where the person is, never a claim about service availability.
function resolveTextToFullGeo(text){
  return new Promise(function(resolve){
    if(typeof google==='undefined' || !google.maps || !google.maps.Geocoder){
      resolve(null); return;
    }
    var geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address: text }, function(results, status){
      if(status !== 'OK' || !results || !results.length){ resolve(null); return; }
      var comps = results[0].address_components || [];
      var out = {pincode:null, areaLabel:results[0].formatted_address||text, cityName:null, citySlug:null, district:null, state:null, country:null};
      comps.forEach(function(c){
        if(c.types.indexOf('postal_code')>=0) out.pincode = c.long_name;
        if(c.types.indexOf('locality')>=0) out.cityName = c.long_name;
        if(!out.cityName && c.types.indexOf('administrative_area_level_2')>=0) out.cityName = c.long_name;
        if(c.types.indexOf('administrative_area_level_2')>=0) out.district = c.long_name;
        if(c.types.indexOf('administrative_area_level_1')>=0) out.state = c.long_name;
        if(c.types.indexOf('country')>=0) out.country = c.long_name;
      });
      if(out.cityName){
        out.citySlug = out.cityName.toLowerCase().trim().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
      }
      resolve(out);
    });
  });
}

/**
 * Records a city/district/state/country as "seen" in a single lightweight
 * document (siteMeta/knownLocations), using arrayUnion so it's safe to call
 * on every registration without ever creating duplicates. This is what lets
 * Discover People's District/State/Country/City scope selectors grow to
 * include real places people actually registered from — not just DELTA's
 * own cityConfig-registered cities — without needing an expensive
 * distinct-values scan across every mediaProfiles document.
 * Safe to call with any field left null/undefined (arrayUnion of a falsy
 * value is skipped rather than polluting the list with blanks).
 */
function recordKnownLocation(geoFields){
  if(!geoFields) return;
  var update = {};
  if(geoFields.city) update.cities = firebase.firestore.FieldValue.arrayUnion(geoFields.city);
  if(geoFields.district) update.districts = firebase.firestore.FieldValue.arrayUnion(geoFields.district);
  if(geoFields.state) update.states = firebase.firestore.FieldValue.arrayUnion(geoFields.state);
  if(geoFields.country) update.countries = firebase.firestore.FieldValue.arrayUnion(geoFields.country);
  if(!Object.keys(update).length) return;
  db.collection('siteMeta').doc('knownLocations').set(update, {merge:true})
    .catch(function(e){ console.warn('recordKnownLocation failed (non-fatal)', e); });
}

var _knownLocationsCache = null;
/**
 * Fetches the full known-locations record (with a session cache, same TTL
 * pattern as getCityGeo). Returns {cities:[], districts:[], states:[], countries:[]}.
 */
async function getKnownLocations(){
  if(_knownLocationsCache) return _knownLocationsCache;
  var cached = _cmCacheRead('cm_known_locations');
  if(cached){ _knownLocationsCache = cached; return cached; }
  var empty = {cities:[], districts:[], states:[], countries:[]};
  try{
    var doc = await db.collection('siteMeta').doc('knownLocations').get();
    var data = doc.exists ? doc.data() : empty;
    _knownLocationsCache = data;
    _cmCacheWrite('cm_known_locations', data);
    return data;
  }catch(e){ console.warn('getKnownLocations failed, using empty list', e); return empty; }
}

/**
 * Firestore's `==` queries are case-sensitive, so searching "delhi" would
 * never match a stored "Delhi Division" — this computes lowercase-normalized
 * copies of each location field (homeCity_lower, district_lower, etc.) at
 * write time, so queries can compare against THESE instead of the original
 * properly-cased display fields, while still showing the nice display
 * version everywhere in the UI. Call this once and spread its result into
 * every profile/customer write alongside the real geoFields.
 */
function lowercaseGeoFields(geoFields){
  return {
    homeCity_lower: geoFields.city ? geoFields.city.toLowerCase() : null,
    district_lower: geoFields.district ? geoFields.district.toLowerCase() : null,
    state_lower: geoFields.state ? geoFields.state.toLowerCase() : null,
    country_lower: geoFields.country ? geoFields.country.toLowerCase() : null
  };
}

/**
 * Resizes + compresses an image file/blob client-side (canvas re-encode)
 * before it ever reaches Cloudinary. Added Aug 2026 after the Cloudinary
 * Free plan (25 credits/mo) got disabled from ~40 credits usage — raw phone
 * camera photos (often 8-15MB, 4000px+) were being uploaded and stored
 * at full size everywhere (product photos, seller stories, bazaar catalog,
 * Shorts frames), burning storage credits fast with no visible quality
 * benefit since every on-site display is a card/thumbnail, never a full
 * zoomed original.
 *
 * maxDim caps the longer edge at 1600px by default — comfortably above
 * anything DELTA currently displays (product cards, story rings, catalog
 * grids), so no visible quality loss, while cutting a typical 10MB camera
 * photo down to a few hundred KB. Bump maxDim (not below the current
 * default) only if a future feature needs full-screen zoom/lightbox.
 *
 * Non-image files (e.g. video blobs) are returned unchanged — video
 * compression is a separate, more involved fix and intentionally out of
 * scope here.
 *
 * Returns a Promise<Blob> — always resolves (never rejects) so a decode
 * failure or unsupported type falls back to the original file rather than
 * blocking the upload entirely.
 */
function deltaCompressImage(file, maxDim, quality){
  maxDim = maxDim || 1600;
  quality = quality || 0.85;
  return new Promise(function(resolve){
    if(!file || !file.type || file.type.indexOf('image/') !== 0){ resolve(file); return; }
    if(file.type === 'image/svg+xml' || file.type === 'image/gif'){ resolve(file); return; } // don't touch vector/animated formats
    try{
      var img = new Image();
      var objUrl = URL.createObjectURL(file);
      img.onload = function(){
        try{
          var w = img.naturalWidth, h = img.naturalHeight;
          if(w <= maxDim && h <= maxDim){ URL.revokeObjectURL(objUrl); resolve(file); return; } // already small enough
          var scale = Math.min(maxDim / w, maxDim / h);
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function(blob){
            URL.revokeObjectURL(objUrl);
            resolve(blob || file); // fall back to original if canvas encoding fails
          }, 'image/jpeg', quality);
        }catch(e){ URL.revokeObjectURL(objUrl); resolve(file); }
      };
      img.onerror = function(){ URL.revokeObjectURL(objUrl); resolve(file); };
      img.src = objUrl;
    }catch(e){ resolve(file); }
  });
}

/**
 * Inserts Cloudinary's automatic-quality + automatic-format transformation
 * (q_auto,f_auto) into a stored delivery URL, so the browser gets a
 * WebP/AVIF-where-supported, visually-lossless-compressed version instead
 * of the original upload — cuts delivery bandwidth credits with no visible
 * quality change, and loads faster on the budget Android phones common in
 * DELTA's Tier-3/4/5 target market. Safe no-op on any URL that isn't a
 * res.cloudinary.com delivery URL (emoji fallback, external URL, etc.).
 */
function deltaOptimizeUrl(url){
  if(!url || typeof url !== 'string') return url;
  if(url.indexOf('res.cloudinary.com') === -1) return url;
  if(url.indexOf('/upload/q_auto') !== -1 || url.indexOf('/upload/f_auto') !== -1) return url; // already optimized
  return url.replace('/upload/', '/upload/q_auto,f_auto/');
}

/**
 * Uploads a file to ImageKit — the replacement for every Cloudinary
 * fd.append('file', file) + fetch('api.cloudinary.com/...') pattern
 * previously used across bazaar.html, admin.html, seller-dashboard.html,
 * index.html, create-studio.html, and media-profile.html.
 *
 * WHY THIS SHAPE: Cloudinary allowed unsigned browser uploads via
 * upload_preset alone. ImageKit requires every upload to carry a signed
 * token (token/expire/signature) that can only be generated server-side
 * with the private key — so this function first calls the
 * `getImageKitAuth` Cloud Function to get that signed permission slip,
 * then uploads directly to ImageKit's upload API using it. The private
 * key itself never reaches the browser at any point.
 *
 * Images are compressed client-side first via deltaCompressImage (same
 * as before) — video/audio pass through untouched, matching the existing
 * compression scope decision.
 *
 * @param {File|Blob} file - the file to upload
 * @param {string} folder - ImageKit folder path, e.g. 'delta/products'
 *   (mirrors the folder structure used on Cloudinary for continuity)
 * @param {string} [fileName] - optional filename; ImageKit auto-generates
 *   a unique name if omitted, similar to Cloudinary's default behavior
 * @param {number} [maxDim] - passed through to deltaCompressImage
 * @param {number} [quality] - passed through to deltaCompressImage
 * @returns {Promise<{url:string, fileId:string, name:string}>} resolves
 *   with the ImageKit delivery URL on success (data.url — the equivalent
 *   of Cloudinary's data.secure_url in the old code), throws on failure
 *   so existing try/catch blocks around upload calls keep working as-is.
 */
async function deltaUploadToImageKit(file, folder, fileName, maxDim, quality){
  if(!file) throw new Error('কোনো ফাইল দেওয়া হয়নি');

  // Compress images (no-op for video/audio/svg/gif — see deltaCompressImage)
  var uploadFile = await deltaCompressImage(file, maxDim, quality);

  // Get a signed auth token from the Cloud Function — this call requires
  // Firebase to already be initialized on the page (all 6 upload-capable
  // pages already load Firebase for other features, so this is safe).
  var authResult;
  try{
    var getAuth = firebase.functions().httpsCallable('getImageKitAuth');
    var authResponse = await getAuth();
    authResult = authResponse.data;
  }catch(authErr){
    throw new Error('আপলোড অনুমতি পাওয়া যায়নি — ইন্টারনেট সংযোগ চেক করুন। (' + (authErr.message||'') + ')');
  }

  var fd = new FormData();
  fd.append('file', uploadFile, fileName || ('delta_' + Date.now() + '.jpg'));
  fd.append('publicKey', authResult.publicKey);
  fd.append('signature', authResult.signature);
  fd.append('expire', authResult.expire);
  fd.append('token', authResult.token);
  fd.append('folder', folder || 'delta/misc');
  if(fileName) fd.append('fileName', fileName);
  fd.append('useUniqueFileName', fileName ? 'false' : 'true');

  var uploadRes = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
    method: 'POST',
    body: fd
  });
  var uploadData = await uploadRes.json();
  if(!uploadRes.ok || !uploadData.url){
    throw new Error(uploadData.message || 'ImageKit আপলোড ব্যর্থ হয়েছে');
  }
  return uploadData; // { url, fileId, name, ... } — use uploadData.url same as old data.secure_url
}
 


