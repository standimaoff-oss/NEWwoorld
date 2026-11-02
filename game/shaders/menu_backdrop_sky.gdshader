shader_type sky;

// ============================================================
//  menu_backdrop_sky.gdshader — процедурное небо для 3D-меню
//
//  ЗАЧЕМ ПРОЦЕДУРНОЕ, А НЕ ПАННОРАМА. Меню должно занимать единицы
//  мегабайт и грузиться мгновенно: игрок ждёт главного меню секунду,
//  а не двадцать. HDR-панорама весит 4–20 МБ и требует загрузки.
//  Процедурное небо весит 2 КБ текста и не требует ни одного ассета.
//
//  Плюс оно АНИМИРУЕМО: облака плывут, солнце дышит, звёзды мерцают.
//  Статичное меню выглядит как заставка, живое — как часть игры.
//
//  Шейдер намеренно дешёвый: 3 октавы шума, никаких трассировок. Меню
//  крутится, пока игрок читает настройки, и не должно греть видеокарту.
// ============================================================

uniform vec3 sky_top_color : source_color = vec3(0.043, 0.055, 0.098);
uniform vec3 sky_horizon_color : source_color = vec3(0.204, 0.243, 0.322);
uniform vec3 sky_bottom_color : source_color = vec3(0.016, 0.020, 0.031);
uniform vec3 sun_color : source_color = vec3(1.0, 0.78, 0.45);
uniform vec3 cloud_color : source_color = vec3(0.55, 0.58, 0.68);
uniform vec3 accent_color : source_color = vec3(0.28, 0.72, 0.85);

// Направление на солнце. Совпадает с DirectionalLight3D в сцене меню —
// иначе тень на объектах будет расходиться с видимым солнцем, и это
// считывается мгновенно, даже если игрок не может сформулировать почему.
uniform vec3 sun_direction = vec3(-0.42, 0.28, -0.86);
uniform float sun_size : hint_range(0.0, 0.2) = 0.028;
uniform float sun_intensity : hint_range(0.0, 20.0) = 4.5;
uniform float horizon_glow : hint_range(0.0, 3.0) = 0.85;

uniform float cloud_coverage : hint_range(0.0, 1.0) = 0.42;
uniform float cloud_sharpness : hint_range(0.5, 12.0) = 3.2;
uniform vec2 cloud_speed = vec2(0.006, 0.0035);
uniform float cloud_scale : hint_range(0.2, 8.0) = 1.4;
uniform float cloud_altitude : hint_range(0.0, 1.0) = 0.22;

uniform float star_density : hint_range(0.0, 1.0) = 0.55;
uniform float star_brightness : hint_range(0.0, 3.0) = 1.0;

uniform float time_scale : hint_range(0.0, 4.0) = 1.0;

// Хеш без синусов: синусные хеши дают видимые диагональные полосы на
// больших координатах, а звёздное поле — как раз такой случай.
float hash21(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.xx + p3.yz) * p3.zy);
}

float value_noise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	float a = hash21(i);
	float b = hash21(i + vec2(1.0, 0.0));
	float c = hash21(i + vec2(0.0, 1.0));
	float d = hash21(i + vec2(1.0, 1.0));
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Три октавы — достаточно для читаемых облаков. Каждая следующая октава
// удваивает цену, а на небе меню разница между 3 и 6 октавами не видна.
float fbm3(vec2 p) {
	float sum = 0.0;
	float amplitude = 0.5;
	for (int i = 0; i < 3; i++) {
		sum += amplitude * value_noise(p);
		p *= 2.02;
		amplitude *= 0.5;
	}
	return sum;
}

vec3 stars(vec3 dir, float time) {
	// Звёзды раскладываются по кубу направлений, а не по сфере: иначе
	// у полюсов плотность растёт и появляется видимый «водоворот».
	vec3 p = dir * 90.0;
	vec3 cell = floor(p);
	vec3 local = fract(p) - 0.5;
	float h = hash21(cell.xy + cell.z * 31.7);
	if (h > star_density) {
		return vec3(0.0);
	}
	vec2 offset = hash22(cell.xz + cell.y * 17.3) - 0.5;
	float distance_to_star = length(local.xy - offset * 0.6);
	float core = smoothstep(0.055, 0.0, distance_to_star);
	// Мерцание: медленное и с индивидуальной фазой на звезду.
	// Синхронное мерцание всего неба выглядит как стробоскоп.
	float twinkle = 0.65 + 0.35 * sin(time * 1.7 + h * 62.8);
	float tint_variation = hash21(cell.yz);
	vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.86, 0.7), tint_variation);
	return tint * core * twinkle * star_brightness * (0.4 + h * 0.9);
}

void sky() {
	vec3 dir = normalize(EYEDIR);
	float time = TIME * time_scale;

	// --- Базовый градиент неба ---------------------------------------
	// Не линейный по высоте: у горизонта небо светлеет резко, и линейная
	// интерполяция даёт неестественно «пластмассовый» переход.
	float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
	vec3 base = mix(sky_horizon_color, sky_top_color, pow(up, 0.75));
	base = mix(sky_bottom_color, base, smoothstep(0.0, 0.35, up));

	// --- Солнце -------------------------------------------------------
	vec3 sun_dir = normalize(sun_direction);
	float sun_alignment = max(dot(dir, sun_dir), 0.0);
	float sun_disc = smoothstep(1.0 - sun_size, 1.0 - sun_size * 0.35, sun_alignment);
	float sun_halo = pow(sun_alignment, 24.0) * 0.55 + pow(sun_alignment, 5.0) * 0.12;
	// Дыхание солнца: очень медленное, почти незаметное осознанно.
	// Именно такие детали отличают живую сцену от картинки.
	float breathe = 1.0 + sin(time * 0.23) * 0.04;
	vec3 sun = sun_color * (sun_disc * sun_intensity + sun_halo * sun_intensity * 0.5) * breathe;

	// --- Свечение у горизонта ----------------------------------------
	float horizon_band = pow(1.0 - abs(dir.y), 6.0);
	vec3 glow = mix(sun_color, accent_color, 0.35) * horizon_band * horizon_glow;

	// --- Облака -------------------------------------------------------
	// Проекция направления на плоскость на высоте cloud_altitude.
	// Деление на dir.y даёт перспективное растяжение у горизонта —
	// облака начинают двигаться быстрее к краям, как настоящие.
	float cloud_factor = 0.0;
	if (dir.y > 0.01 && cloud_coverage > 0.001) {
		vec2 plane = dir.xz / max(dir.y, 0.05);
		vec2 scrolled = plane * cloud_scale + vec2(time * cloud_speed.x, time * cloud_speed.y);
		float density = fbm3(scrolled);
		// coverage сдвигает порог: 0 = чистое небо, 1 = сплошная пелена.
		float threshold = mix(0.85, 0.15, cloud_coverage);
		cloud_factor = smoothstep(threshold, threshold + (1.0 / cloud_sharpness), density);
		// У горизонта облака истончаются — иначе получается «стена».
		cloud_factor *= smoothstep(0.01, 0.25, dir.y);
	}
	// Подсветка облаков со стороны солнца.
	float cloud_lit = mix(0.35, 1.25, pow(sun_alignment, 2.0));
	vec3 clouds = cloud_color * cloud_lit * cloud_factor;

	vec3 color = base + glow + sun;
	color = mix(color, clouds, clamp(cloud_factor, 0.0, 1.0));
	color += stars(dir, time) * (1.0 - cloud_factor) * smoothstep(0.25, 0.0, sun_alignment * 0.3);

	COLOR = color;

	// ALPHA в sky-шейдере не используется для прозрачности, но Godot
	// читает его как «насколько небо перекрывает фон». Оставляем 1.
	ALPHA = 1.0;
}
