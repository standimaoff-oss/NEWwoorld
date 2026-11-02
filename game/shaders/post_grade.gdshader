shader_type canvas_item;

// ============================================================
//  post_grade.gdshader — цветокоррекция и режимы дальтонизма
//
//  Вешается как ColorRect с материалом поверх всего экрана (CanvasLayer
//  с высоким layer). Один проход на кадр, стоимость — несколько
//  умножений на пиксель.
//
//  РЕЖИМЫ ДАЛЬТОНИЗМА реализованы через матрицы в линейном пространстве,
//  полученные из LMS-преобразования. Это не «прикрутим красный фильтр»:
//  такой подход СДВИГАЕТ цвета так, чтобы различимые для данного типа
//  дальтонизма пары (красный/зелёный) расходились по яркости и по синему
//  каналу. Игрок с дейтеранопией перестает путать «враг» и «союзник»,
//  если те различались только оттенком зелёного.
//
//  Доступность — не опция «для галочки». По разным оценкам, нарушения
//  цветовосприятия есть у ~8% мужчин; на аудитории в 100 000 игроков
//  это 8 000 человек, которые без этого шейдера просто не смогут играть.
// ============================================================

uniform sampler2D screen_texture : hint_screen_texture, filter_linear_mipmap;

// Режим: 0 = выкл, 1 = протанопия, 2 = дейтеранопия, 3 = тританопия.
// Совпадает с порядком в SettingsSchema accessibility/colorblind_mode.
uniform int colorblind_mode : hint_range(0, 3) = 0;
uniform float colorblind_intensity : hint_range(0.0, 1.0) = 1.0;

uniform float saturation : hint_range(0.0, 2.0) = 1.0;
uniform float contrast : hint_range(0.0, 2.0) = 1.0;
uniform float brightness : hint_range(-1.0, 1.0) = 0.0;
uniform float gamma : hint_range(0.4, 2.5) = 1.0;

// Виньетка. В меню она собирает композицию к центру; в игре её обычно
// выключают или делают едва заметной — сильная виньетка мешает обзору.
uniform float vignette_strength : hint_range(0.0, 1.0) = 0.18;
uniform float vignette_softness : hint_range(0.01, 1.0) = 0.42;
uniform vec4 vignette_color : source_color = vec4(0.0, 0.0, 0.0, 1.0);

// Тонировка теней и светов — самый дешёвый способ задать настроение.
uniform vec4 shadow_tint : source_color = vec4(0.16, 0.20, 0.30, 1.0);
uniform vec4 highlight_tint : source_color = vec4(1.0, 0.96, 0.90, 1.0);
uniform float tint_strength : hint_range(0.0, 1.0) = 0.28;

// Плёночное зерно. В малых дозах убирает «пластиковость» градиентов
// и, что важно, разбивает бандинг на тёмных переходах неба.
uniform float grain_amount : hint_range(0.0, 0.15) = 0.012;

// Хроматическая аберрация по краям кадра. Дешёвая «линзовость».
uniform float chromatic_aberration : hint_range(0.0, 0.01) = 0.0;

// Матрицы симуляции дальтонизма (Brettel/Viénot в линейном sRGB).
const mat3 PROTAN = mat3(
		vec3(0.152286, 1.052583, -0.204868),
		vec3(0.114503, 0.786281, 0.099216),
		vec3(-0.003882, -0.048116, 1.051998));
const mat3 DEUTERAN = mat3(
		vec3(0.367322, 0.632678, 0.000000),
		vec3(0.280085, 0.719915, 0.000000),
		vec3(-0.011820, 0.042940, 0.968881));
const mat3 TRITAN = mat3(
		vec3(1.000000, 0.000000, 0.000000),
		vec3(0.000000, 1.000000, 0.000000),
		vec3(-0.867447, 1.867271, 0.000177));

vec3 apply_colorblind(vec3 color) {
	mat3 transform;
	if (colorblind_mode == 1) {
		transform = PROTAN;
	} else if (colorblind_mode == 2) {
		transform = DEUTERAN;
	} else if (colorblind_mode == 3) {
		transform = TRITAN;
	} else {
		return color;
	}
	// Не «симулируем» дальтонизм, а КОМПЕНСИРУЕМ: берем разницу между
	// исходным и симулированным цветом и добавляем её обратно с усилением.
	// В результате пары цветов, неразличимые для данного типа, расходятся.
	vec3 simulated = transform * color;
	vec3 compensation = color - simulated;
	return clamp(color + compensation * colorblind_intensity * 1.6, 0.0, 1.0);
}

float grain(vec2 uv, float time) {
	vec2 noise_coord = uv * vec2(1920.0, 1080.0) + vec2(time * 13.7, time * 7.3);
	return fract(sin(dot(noise_coord, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
}

void fragment() {
	vec2 uv = SCREEN_UV;
	vec3 color;

	if (chromatic_aberration > 0.0001) {
		// Смещение растёт к краям кадра: в центре аберрация у настоящей
		// оптики минимальна. Равномерное смещение выглядит как баг.
		vec2 offset = (uv - 0.5) * chromatic_aberration;
		color.r = texture(screen_texture, uv + offset).r;
		color.g = texture(screen_texture, uv).g;
		color.b = texture(screen_texture, uv - offset).b;
	} else {
		color = texture(screen_texture, uv).rgb;
	}

	color = apply_colorblind(color);

	// Яркость/контраст/насыщенность — в этом порядке. Контраст после
	// яркости, иначе яркость «съедает» только что выставленный контраст.
	color = clamp(color + brightness, 0.0, 1.0);
	color = clamp((color - 0.5) * contrast + 0.5, 0.0, 1.0);
	float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
	color = mix(vec3(luma), color, saturation);

	// Тонировка: тени тянем к shadow_tint, света — к highlight_tint.
	vec3 tinted = mix(shadow_tint.rgb * color, color, smoothstep(0.0, 0.55, luma));
	tinted = mix(tinted, highlight_tint.rgb * color, smoothstep(0.45, 1.0, luma));
	color = mix(color, tinted, tint_strength);

	color = pow(max(color, vec3(0.0)), vec3(1.0 / max(gamma, 0.0001)));

	// Виньетка.
	float distance_from_center = length(uv - 0.5) * 1.4142136;
	float vignette = smoothstep(1.0 - vignette_softness, 1.0, distance_from_center);
	color = mix(color, mix(color, vignette_color.rgb, 0.9), vignette * vignette_strength);

	color += grain(uv, TIME) * grain_amount;

	COLOR = vec4(clamp(color, 0.0, 1.0), 1.0);
}
