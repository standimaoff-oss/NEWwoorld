shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back, diffuse_burley, specular_schlick_ggx;

// ============================================================
//  water_surface.gdshader — стилизованная вода
//
//  Осознанно НЕ физически корректная вода (SSR + refraction + caustics
//  стоят десятки миллисекунд), а читаемая стилизованная: две нормальные
//  карты, глубинный градиент, пена у берега, френелевское отражение неба.
//
//  ГЛАВНЫЙ ПРИЁМ — DEPTH_TEXTURE. Без него вода выглядит как синий
//  пластик одинаковой толщины и над метром, и над сантиметром. С ним
//  мелководье прозрачное и светлое, глубина тёмная и плотная — и игрок
//  без единого слова понимает, где можно перейти вброд.
//
//  Стоимость: 2 выборки текстур + 1 выборка глубины на пиксель.
//  Это в разы дешевле SSR и при этом даёт 90% визуальной отдачи.
// ============================================================

uniform sampler2D normal_map_a : filter_linear_mipmap, repeat_enable;
uniform sampler2D normal_map_b : filter_linear_mipmap, repeat_enable;
uniform sampler2D depth_texture : hint_depth_texture, filter_linear_mipmap;
uniform sampler2D foam_noise : filter_linear_mipmap, repeat_enable;

uniform vec4 shallow_color : source_color = vec4(0.32, 0.72, 0.74, 0.55);
uniform vec4 deep_color : source_color = vec4(0.02, 0.13, 0.22, 0.94);
uniform vec4 foam_color : source_color = vec4(0.92, 0.96, 1.0, 1.0);

// На какой глубине цвет полностью переходит в «глубокий», метры.
uniform float depth_range : hint_range(0.05, 20.0) = 2.6;
uniform float normal_strength : hint_range(0.0, 2.0) = 0.55;
uniform float wave_scale : hint_range(0.01, 4.0) = 0.35;

// Две волны движутся в РАЗНЫХ направлениях и с разной скоростью.
// Одна волна даёт узнаваемо «компьютерную» регулярную рябь: глаз ловит
// период за пару секунд. Пересечение двух систем ломает периодичность.
uniform vec2 wave_a_speed = vec2(0.045, 0.028);
uniform vec2 wave_b_speed = vec2(-0.031, 0.052);
uniform float wave_b_scale_ratio : hint_range(0.3, 3.0) = 1.73;

uniform float foam_shore_width : hint_range(0.0, 2.0) = 0.35;
uniform float foam_wave_crest : hint_range(0.0, 1.0) = 0.22;

uniform float roughness_shallow : hint_range(0.0, 1.0) = 0.06;
uniform float roughness_deep : hint_range(0.0, 1.0) = 0.14;
uniform float specular_strength : hint_range(0.0, 2.0) = 0.85;

// Ветер из глобальных параметров (публикует WindSystem): вода гонит
// волну по тому же направлению, что и листва. Несогласованность ветра
// и воды — одна из самых заметных фальшивок в открытых сценах.
uniform vec3 wind_direction;
uniform float wind_strength;
uniform float wind_gust;

varying float v_depth_factor;
varying float v_foam;

// Линейная глубина сцены в этой точке экрана, метры от камеры.
//
// Значение в depth-текстуре НЕлинейное: оно сжато к дальней плоскости
// отсечения. Если использовать его напрямую, «мелководье» получится
// шириной в сантиметр у камеры и в десятки метров вдалеке. Поэтому
// восстанавливаем позицию в видовом пространстве через INV_PROJECTION.
float scene_linear_depth(vec2 screen_uv) {
	float raw_depth = texture(depth_texture, screen_uv).r;
	vec4 clip = INV_PROJECTION_MATRIX * vec4(screen_uv * 2.0 - 1.0, raw_depth, 1.0);
	clip.xyz /= clip.w;
	// Камера смотрит вдоль -Z, поэтому расстояние положительно после инверсии.
	return -clip.z;
}

void vertex() {
	// Дешёвая геометрия волн: две синусоиды по направлению ветра.
	// Полноценная FFT-вода (Gerstner/Tessendorf) здесь избыточна —
	// она нужна в открытом море, а не у берега.
	vec3 wind_dir = normalize(wind_direction + vec3(0.0001, 0.0, 0.0));
	float wind_power = clamp(wind_strength * 0.12 + wind_gust * 0.25, 0.0, 1.0);
	float phase_a = dot(VERTEX.xz, wind_dir.xz * 0.9) + TIME * 1.3;
	float phase_b = dot(VERTEX.xz, wind_dir.zx * 1.7) + TIME * 0.83;
	VERTEX.y += (sin(phase_a) * 0.035 + sin(phase_b) * 0.022) * (0.3 + wind_power);
}

void fragment() {
	// --- Глубина --------------------------------------------------------
	// ВАЖНО: во фрагментном шейдере spatial VERTEX уже приведён к ВИДОВОМУ
	// пространству, поэтому -VERTEX.z — это линейное расстояние от камеры
	// до поверхности воды в этом пикселе. Отдельно считать его не нужно.
	float scene_depth = scene_linear_depth(SCREEN_UV);
	float surface_depth = -VERTEX.z;
	// Толща воды = глубина дна минус глубина поверхности. Отрицательной она
	// бывает, когда камера под водой или из-за точности у самого берега.
	float water_thickness = max(0.0, scene_depth - surface_depth);
	float depth_factor = clamp(water_thickness / max(depth_range, 0.001), 0.0, 1.0);
	v_depth_factor = depth_factor;

	// --- Нормали --------------------------------------------------------
	vec2 wind_uv = normalize(wind_direction.xz + vec2(0.0001)) * wind_strength * 0.02;
	vec2 uv_a = UV * wave_scale + wind_uv + TIME * wave_a_speed;
	vec2 uv_b = UV * wave_scale * wave_b_scale_ratio - wind_uv + TIME * wave_b_speed;
	vec3 normal_a = texture(normal_map_a, uv_a).xyz * 2.0 - 1.0;
	vec3 normal_b = texture(normal_map_b, uv_b).xyz * 2.0 - 1.0;
	// Сложение двух нормалей, а не их усреднение: усреднение гасит детали,
	// а вода должна оставаться «острой» на мелкой ряби.
	vec3 combined = normalize(vec3(
			(normal_a.xy + normal_b.xy) * normal_strength,
			abs(normal_a.z) + abs(normal_b.z)));
	NORMAL = normalize(NORMAL + combined * 0.5);

	// --- Пена ------------------------------------------------------------
	// У берега (малая глубина) и на гребнях волн.
	float shore = 1.0 - smoothstep(0.0, foam_shore_width, water_thickness);
	float crest_noise = texture(foam_noise, UV * 6.0 + TIME * 0.05).r;
	float crest = smoothstep(1.0 - foam_wave_crest, 1.0, crest_noise + depth_factor * 0.2);
	v_foam = clamp(shore * 0.85 + crest * 0.35, 0.0, 1.0);

	// --- Цвет ------------------------------------------------------------
	vec3 water = mix(shallow_color.rgb, deep_color.rgb, depth_factor);
	ALBEDO = mix(water, foam_color.rgb, v_foam);
	ALPHA = mix(shallow_color.a, deep_color.a, depth_factor);
	ALPHA = mix(ALPHA, foam_color.a, v_foam);

	ROUGHNESS = mix(roughness_shallow, roughness_deep, depth_factor);
	ROUGHNESS = mix(ROUGHNESS, 0.55, v_foam);
	SPECULAR = specular_strength;

	// Пена должна светиться чуть сильнее — иначе она серая, а не белая.
	EMISSION = foam_color.rgb * v_foam * 0.08;
}
