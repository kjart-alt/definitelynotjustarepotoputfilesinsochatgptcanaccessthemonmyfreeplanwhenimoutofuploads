// Числа цифрами: «fünf und dreißig» → «35».
//
// Живая модель (nemotron) на всех языках пишет числа только словами — в трёх
// минутах немецкого, французского, английского вывода нет ни одной цифры. Человек
// в субтитрах пишет «35 Schüler», «5 Milliarden», «28歳», и ютуб тоже. Цена этому
// не косметическая: на немецком ролике PcrjibVL1FQ весь разрыв с ютубом (94.3)
// давали именно числа — вне их мы ошибаемся почти теми же словами, что и он. Хуже
// того, «fünf und dreißig» переводчик Chrome честно переводит как «five and
// thirty», то есть число портится ещё и по смыслу.
//
// Поэтому перед показом и переводом строка проходит обратную нормализацию: ряд
// числительных сворачивается в цифры. Правила, которые здесь держатся, взяты из
// эталонов, а не из вкуса:
//
// - одинокое однозначное остаётся словом. В ручных субтитрах «drei», «cinq»,
//   «five» пишут словами чаще, чем цифрами (fr 121 против 23, en 50 против 2,
//   es 38 против 2), а «ein», «un», «one», «a» — ещё и артикли;
// - всё от десяти и всё, что сказано больше чем одним словом, — цифрами
//   (в тех же эталонах «10+» цифрами почти всегда);
// - одинокое «сто», «тысяча», «hundert», «mille» остаётся словом: «тысячи
//   людей», «hundert Mal» — не числа;
// - «eine Million» остаётся словом, «zwei Millionen» → «2 Millionen», как в
//   эталоне («5 Milliarden Euro»);
// - числительное перед порядковым («двадцать пятый», «vingt et unième») не
//   трогаем: «20 пятый» хуже слов;
// - у японского цифры и для однозначных со счётным словом (эталон
//   4jfcE8u9KOM: «５年間», «８年目», «３つ»), но «一番», «一緒», «一人» — слова.
//
// Открытая строка ещё растёт: хвостовое «fünf und» может стать «fünf und
// dreißig», поэтому числительные в самом конце незакрытой строки не трогаем —
// они свернутся, когда за ними придёт другое слово или строка закроется.

// ── словари ────────────────────────────────────────────────────────────────
//
// Запись: «слово слово=значение[признаки]; …». Признаки:
//   *  множитель внутри группы (сто, hundert, 十): умножает то, что перед ним;
//   ^  шкала (тысяча, million, 万): закрывает группу;
//   !  только после числа: «тысяч», «millions», «sataa» сами числом не начинают;
//   +  «-надцать» после единицы: «toista», «עשר», «عشر»;
//   ~  только после десятков (вьетнамское «lăm», «mốt», «tư»);
//   -  не после десятков (вьетнамское «năm»: «hai mươi năm» — «20 лет»);
//   ?  только перед множителем (английское «a hundred», тайское «ยี่สิบ»);
//   2  шкала с двойкой внутри: «אלפיים», «ألفان» — две тысячи одним словом.

const LEX = {
  en: {
    words: `one=1; a=1?; two=2; three=3; four=4; five=5; six=6; seven=7; eight=8; nine=9; ten=10;
      eleven=11; twelve=12; thirteen=13; fourteen=14; fifteen=15; sixteen=16; seventeen=17;
      eighteen=18; nineteen=19; twenty=20; thirty=30; forty fourty=40; fifty=50; sixty=60;
      seventy=70; eighty=80; ninety=90; hundred=100*; thousand=1000^; million=1e6^;
      billion=1e9^; trillion=1e12^`,
    conn: { and: 'after' }, decimal: ['point'],
    ordinal: /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|\p{L}+teenth|\p{L}+tieth|hundredth|thousandth|millionth)$/u,
    years: true
  },
  de: {
    words: `eins ein eine einen einem einer eines=1; zwei zwo=2; drei=3; vier=4; fünf=5; sechs=6;
      sieben=7; acht=8; neun=9; zehn=10; elf=11; zwölf=12; dreizehn=13; vierzehn=14;
      fünfzehn=15; sechzehn=16; siebzehn=17; achtzehn=18; neunzehn=19; zwanzig=20;
      dreißig dreissig=30; vierzig=40; fünfzig=50; sechzig=60; siebzig=70; achtzig=80;
      neunzig=90; hundert=100*; tausend=1000^; million=1e6^; millionen=1e6^!;
      milliarde=1e9^; milliarden=1e9^!`,
    conn: { und: 'unit' }, glue: true, decimal: ['komma']
  },
  nl: {
    words: `een één eén=1; twee=2; drie=3; vier=4; vijf=5; zes=6; zeven=7; acht=8; negen=9;
      tien=10; elf=11; twaalf=12; dertien=13; veertien=14; vijftien=15; zestien=16;
      zeventien=17; achttien=18; negentien=19; twintig=20; dertig=30; veertig=40;
      vijftig=50; zestig=60; zeventig=70; tachtig=80; negentig=90; honderd=100*;
      duizend=1000^; miljoen=1e6^; miljard=1e9^`,
    conn: { en: 'unit', 'ën': 'unit' }, glue: true, decimal: ['komma']
  },
  sv: {
    words: `en ett=1; två=2; tre=3; fyra=4; fem=5; sex=6; sju=7; åtta=8; nio=9; tio=10; elva=11;
      tolv=12; tretton=13; fjorton=14; femton=15; sexton=16; sjutton=17; arton=18;
      nitton=19; tjugo tjugu=20; trettio tretti=30; fyrtio fyrti=40; femtio femti=50;
      sextio sexti=60; sjuttio sjutti=70; åttio åtti=80; nittio nitti=90; hundra=100*;
      tusen=1000^; miljon=1e6^; miljoner=1e6^!; miljard=1e9^; miljarder=1e9^!`,
    glue: true
  },
  da: {
    words: `en et=1; to=2; tre=3; fire=4; fem=5; seks=6; syv=7; otte=8; ni=9; ti=10; elleve=11;
      tolv=12; tretten=13; fjorten=14; femten=15; seksten=16; sytten=17; atten=18;
      nitten=19; tyve=20; tredive=30; fyrre fyrretyve=40; halvtreds halvtredsindstyve=50;
      tres tresindstyve=60; halvfjerds halvfjerdsindstyve=70; firs firsindstyve=80;
      halvfems halvfemsindstyve=90; hundrede hundred=100*; tusind=1000^; million=1e6^;
      millioner=1e6^!; milliard=1e9^; milliarder=1e9^!`,
    conn: { og: 'og' }, glue: true
  },
  nb: {
    words: `en ei ett én=1; to=2; tre=3; fire=4; fem=5; seks=6; sju syv=7; åtte=8; ni=9; ti=10;
      elleve=11; tolv=12; tretten=13; fjorten=14; femten=15; seksten=16; sytten=17;
      atten=18; nitten=19; tjue tyve=20; tretti tredve=30; førti=40; femti=50; seksti=60;
      sytti=70; åtti=80; nitti=90; hundre=100*; tusen=1000^; million=1e6^;
      millioner=1e6^!; milliard=1e9^; milliarder=1e9^!`,
    conn: { og: 'og' }, glue: true
  },
  nn: {
    words: `ein eit éin=1; to=2; tre=3; fire=4; fem=5; seks=6; sju=7; åtte=8; ni=9; ti=10;
      elleve=11; tolv=12; tretten=13; fjorten=14; femten=15; seksten=16; sytten=17;
      atten=18; nitten=19; tjue=20; tretti=30; førti=40; femti=50; seksti=60; sytti=70;
      åtti=80; nitti=90; hundre=100*; tusen=1000^; million=1e6^; millionar=1e6^!;
      milliard=1e9^; milliardar=1e9^!`,
    conn: { og: 'og' }, glue: true
  },
  fr: {
    words: `un une=1; deux=2; trois=3; quatre=4; cinq=5; six=6; sept=7; huit=8; neuf=9; dix=10;
      onze=11; douze=12; treize=13; quatorze=14; quinze=15; seize=16; vingt vingts=20;
      trente=30; quarante=40; cinquante=50; soixante=60; septante=70; huitante octante=80;
      nonante=90; cent cents=100*; mille mil=1000^; million=1e6^; millions=1e6^!;
      milliard=1e9^; milliards=1e9^!`,
    conn: { et: 'down' },
    // «quatre-vingts» — восемьдесят, а не «4 20»; после 60 и 80 идут 10–19:
    // «soixante-dix-sept» = 77, «quatre-vingt-onze» = 91.
    phrases: { 'quatre vingt': 80, 'quatre vingts': 80 }, teenAfter: [60, 80],
    tenUnit: true, decimal: ['virgule'],
    ordinal: /^(premi[eè]re?s?|\p{L}+ièmes?)$/u
  },
  es: {
    words: `uno una un=1; dos=2; tres=3; cuatro=4; cinco=5; seis=6; siete=7; ocho=8; nueve=9;
      diez=10; once=11; doce=12; trece=13; catorce=14; quince=15; dieciséis dieciseis=16;
      diecisiete=17; dieciocho=18; diecinueve=19; veinte=20; veintiuno veintiún veintiuna=21;
      veintidós veintidos=22; veintitrés veintitres=23; veinticuatro=24; veinticinco=25;
      veintiséis veintiseis=26; veintisiete=27; veintiocho=28; veintinueve=29; treinta=30;
      cuarenta=40; cincuenta=50; sesenta=60; setenta=70; ochenta=80; noventa=90;
      cien ciento=100*; doscientos doscientas=200; trescientos trescientas=300;
      cuatrocientos cuatrocientas=400; quinientos quinientas=500; seiscientos seiscientas=600;
      setecientos setecientas=700; ochocientos ochocientas=800; novecientos novecientas=900;
      mil=1000^; millón millon=1e6^; millones=1e6^!; billón billon=1e12^; billones=1e12^!`,
    conn: { y: 'tens' }, decimal: ['coma', 'punto']
  },
  pt: {
    words: `um uma=1; dois duas=2; três tres=3; quatro=4; cinco=5; seis=6; sete=7; oito=8; nove=9;
      dez=10; onze=11; doze=12; treze=13; catorze quatorze=14; quinze=15;
      dezesseis dezasseis=16; dezessete dezassete=17; dezoito=18; dezenove dezanove=19;
      vinte=20; trinta=30; quarenta=40; cinquenta=50; sessenta=60; setenta=70; oitenta=80;
      noventa=90; cem cento=100*; duzentos duzentas=200; trezentos trezentas=300;
      quatrocentos quatrocentas=400; quinhentos quinhentas=500; seiscentos seiscentas=600;
      setecentos setecentas=700; oitocentos oitocentas=800; novecentos novecentas=900;
      mil=1000^; milhão milhao=1e6^; milhões milhoes=1e6^!; bilhão bilhao=1e9^;
      bilhões bilhoes=1e9^!`,
    conn: { e: 'down' }, decimal: ['vírgula', 'virgula', 'ponto']
  },
  it: {
    words: `uno una un=1; due=2; tre tré=3; quattro=4; cinque=5; sei=6; sette=7; otto=8; nove=9;
      dieci=10; undici=11; dodici=12; tredici=13; quattordici=14; quindici=15; sedici=16;
      diciassette=17; diciotto=18; diciannove=19; venti=20; trenta=30; quaranta=40;
      cinquanta=50; sessanta=60; settanta=70; ottanta=80; novanta=90; cento=100*;
      mille=1000^; mila=1000^!; milione=1e6^; milioni=1e6^!; miliardo=1e9^; miliardi=1e9^!`,
    // «ventuno», «trentotto»: десятки теряют гласную перед uno и otto.
    pieces: 'vent=20; trent=30; quarant=40; cinquant=50; sessant=60; settant=70; ottant=80; novant=90',
    glue: true, decimal: ['virgola']
  },
  ro: {
    words: `unu una un=1; o=1?; doi doua=2; trei=3; patru=4; cinci=5; sase=6; sapte=7; opt=8; noua=9;
      zece=10; unsprezece=11; doisprezece douasprezece=12; treisprezece=13;
      paisprezece patrusprezece=14; cincisprezece=15; saisprezece=16; saptesprezece=17;
      optsprezece=18; nouasprezece=19; douazeci=20; treizeci=30; patruzeci=40; cincizeci=50;
      saizeci=60; saptezeci=70; optzeci=80; nouazeci=90; suta=100*; sute=100*!; mie=1000^;
      mii=1000^!; milion=1e6^; milioane=1e6^!; miliard=1e9^; miliarde=1e9^!`,
    // «douăzeci de mii» — «de» перед шкалой часть числа, перед «ani» — нет.
    conn: { si: 'tens', de: 'big' }, flat: true,
    ordinal: /^(\p{L}+lea|cincea|sasea|saptea|treia|patra)$/u
  },
  ru: {
    words: `один одна одно одни одного одной одному одним одном одну=1; два две двух двум двумя=2;
      три трёх трех трём трем тремя=3; четыре четырёх четырех четырём четырем четырьмя=4;
      пять пяти пятью=5; шесть шести шестью=6; семь семи семью=7; восемь восьми восемью восьмью=8;
      девять девяти девятью=9; десять десяти десятью=10; одиннадцать одиннадцати=11;
      двенадцать двенадцати=12; тринадцать тринадцати=13; четырнадцать четырнадцати=14;
      пятнадцать пятнадцати=15; шестнадцать шестнадцати=16; семнадцать семнадцати=17;
      восемнадцать восемнадцати=18; девятнадцать девятнадцати=19; двадцать двадцати двадцатью=20;
      тридцать тридцати тридцатью=30; сорок сорока=40; пятьдесят пятидесяти пятьюдесятью=50;
      шестьдесят шестидесяти=60; семьдесят семидесяти=70; восемьдесят восьмидесяти=80;
      девяносто девяноста=90; сто ста=100*; двести двухсот двумстам двумястами двухстах=200;
      триста трёхсот трехсот трёмстам тремстам=300; четыреста четырёхсот четырехсот=400;
      пятьсот пятисот пятистам=500; шестьсот шестисот=600; семьсот семисот=700;
      восемьсот восьмисот=800; девятьсот девятисот=900; тысяча=1000^;
      тысячи тысяч тысячу тысячей тысячам тысячами тысячах тысяче=1000^!; миллион=1e6^;
      миллиона миллионов миллиону миллионом миллионами миллионах миллионе=1e6^!;
      миллиард=1e9^; миллиарда миллиардов миллиарду миллиардом миллиардами=1e9^!`,
    decimal: ['целых', 'запятая'],
    ordinal: /^(перв|втор|трет|четв[её]рт|пят|шест|седьм|восьм|девят|десят|\p{L}+надцат|двадцат|тридцат|сороков|\p{L}+десят|девяност|сот|двухсот|трёхсот|трехсот|\p{L}+сот|тысячн|миллионн)(ый|ий|ой|ая|яя|ое|ее|ого|его|ому|ему|ом|ем|ую|юю|ые|ие|ых|их|ым|им|ыми|ими)$/u
  },
  uk: {
    words: `один одна одне одно одного одної однієї одному одній одним одну=1; два дві двох двом двома=2;
      три трьох трьом трьома=3; чотири чотирьох чотирьом чотирма=4; п'ять п'яти п'ятьох п'ятьма=5;
      шість шести шістьох шістьма=6; сім семи сімох сьома сімома=7; вісім восьми вісьмох вісьма вісьмома=8;
      дев'ять дев'яти дев'ятьох дев'ятьма=9; десять десяти десятьох десятьма=10;
      одинадцять одинадцяти=11; дванадцять дванадцяти=12; тринадцять тринадцяти=13;
      чотирнадцять чотирнадцяти=14; п'ятнадцять п'ятнадцяти=15; шістнадцять шістнадцяти=16;
      сімнадцять сімнадцяти=17; вісімнадцять вісімнадцяти=18; дев'ятнадцять дев'ятнадцяти=19;
      двадцять двадцяти двадцятьма=20; тридцять тридцяти тридцятьма=30; сорок сорока=40;
      п'ятдесят п'ятдесяти=50; шістдесят шістдесяти=60; сімдесят сімдесяти=70;
      вісімдесят вісімдесяти=80; дев'яносто дев'яноста=90; сто ста=100*; двісті двохсот=200;
      триста трьохсот=300; чотириста чотирьохсот=400; п'ятсот п'ятисот=500; шістсот шестисот=600;
      сімсот семисот=700; вісімсот восьмисот=800; дев'ятсот дев'ятисот=900; тисяча=1000^;
      тисячі тисяч тисячу тисячею тисячам тисячами=1000^!; мільйон=1e6^;
      мільйона мільйонів мільйону мільйоном мільйонами=1e6^!; мільярд=1e9^;
      мільярда мільярдів мільярду мільярдом=1e9^!`,
    ordinal: /^(перш|друг|трет|четверт|п'ят|шост|сьом|восьм|дев'ят|десят|\p{L}+надцят|двадцят|тридцят|сороков|\p{L}+десят|дев'яност|сот|\p{L}+сот|тисячн|мільйонн)(ий|ій|а|я|е|є|ого|ього|ому|ьому|ім|ій|у|ю|і|их|им|ими)$/u
  },
  bg: {
    words: `един една едно=1; два две двама=2; три трима=3; четири четирима=4; пет петима=5;
      шест шестима=6; седем=7; осем=8; девет=9; десет=10; единадесет единайсет=11;
      дванадесет дванайсет=12; тринадесет тринайсет=13; четиринадесет четиринайсет=14;
      петнадесет петнайсет=15; шестнадесет шестнайсет=16; седемнадесет седемнайсет=17;
      осемнадесет осемнайсет=18; деветнадесет деветнайсет=19; двадесет двайсет=20;
      тридесет трийсет=30; четиридесет четирийсет=40; петдесет=50; шестдесет шейсет=60;
      седемдесет=70; осемдесет=80; деветдесет=90; сто=100*; двеста=200; триста=300;
      четиристотин=400; петстотин=500; шестстотин=600; седемстотин=700; осемстотин=800;
      деветстотин=900; хиляда=1000^; хиляди=1000^!; милион=1e6^; милиона милиони=1e6^!;
      милиард=1e9^; милиарда милиарди=1e9^!`,
    conn: { 'и': 'down' },
    ordinal: /^(първ|втор|трет|четвърт|пет|шест|седм|осм|девет|десет|\p{L}+десет|\p{L}+йсет|стотн|хиляден)(и|а|о|ия|ият|ата|ото|ите)$/u
  },
  pl: {
    words: `jeden jedna jedno jednego jednej jednemu jednym jedną=1; dwa dwie dwóch dwoma dwu dwaj=2;
      trzy trzech trzem trzema=3; cztery czterech czterem czterema=4; pięć pięciu pięcioma=5;
      sześć sześciu sześcioma=6; siedem siedmiu siedmioma=7; osiem ośmiu ośmioma=8;
      dziewięć dziewięciu dziewięcioma=9; dziesięć dziesięciu dziesięcioma=10;
      jedenaście jedenastu=11; dwanaście dwunastu=12; trzynaście trzynastu=13;
      czternaście czternastu=14; piętnaście piętnastu=15; szesnaście szesnastu=16;
      siedemnaście siedemnastu=17; osiemnaście osiemnastu=18; dziewiętnaście dziewiętnastu=19;
      dwadzieścia dwudziestu=20; trzydzieści trzydziestu=30; czterdzieści czterdziestu=40;
      pięćdziesiąt pięćdziesięciu=50; sześćdziesiąt sześćdziesięciu=60;
      siedemdziesiąt siedemdziesięciu=70; osiemdziesiąt osiemdziesięciu=80;
      dziewięćdziesiąt dziewięćdziesięciu=90; sto stu=100*; dwieście dwustu=200;
      trzysta trzystu=300; czterysta czterystu=400; pięćset pięciuset=500;
      sześćset sześciuset=600; siedemset siedmiuset=700; osiemset ośmiuset=800;
      dziewięćset dziewięciuset=900; tysiąc=1000^; tysiące tysięcy tysiąca tysiącu=1000^!;
      milion=1e6^; miliony milionów miliona=1e6^!; miliard=1e9^; miliardy miliardów miliarda=1e9^!`,
    decimal: ['przecinek'],
    ordinal: /^(pierwsz|drug|trzec|czwart|piąt|szóst|siódm|ósm|dziewiąt|dziesiąt|\p{L}+nast|dwudziest|trzydziest|czterdziest|\p{L}+dziesiąt|setn|tysięczn)(y|i|a|e|ego|ej|emu|ym|im|ą|ych|ich|ymi|imi)$/u
  },
  cs: {
    words: `jeden jedna jedno jednoho jedné jednu=1; dva dvě dvou=2; tři tří třech=3; čtyři čtyř=4;
      pět pěti=5; šest šesti=6; sedm sedmi=7; osm osmi=8; devět devíti=9; deset deseti=10;
      jedenáct=11; dvanáct=12; třináct=13; čtrnáct=14; patnáct=15; šestnáct=16; sedmnáct=17;
      osmnáct=18; devatenáct=19; dvacet dvaceti=20; třicet třiceti=30; čtyřicet čtyřiceti=40;
      padesát padesáti=50; šedesát šedesáti=60; sedmdesát sedmdesáti=70; osmdesát osmdesáti=80;
      devadesát devadesáti=90; sto=100*; stě sta set=100*!; tisíc=1000^; tisíce tisíci=1000^!;
      milion=1e6^; miliony milionů=1e6^!; miliarda=1e9^; miliardy miliard=1e9^!`,
    conn: { a: 'unit' }, glue: true
  },
  sk: {
    words: `jeden jedna jedno jedného jednej=1; dva dve dvoch=2; tri troch=3; štyri štyroch=4;
      päť piatich=5; šesť šiestich=6; sedem siedmich=7; osem ôsmich=8; deväť deviatich=9;
      desať desiatich=10; jedenásť=11; dvanásť=12; trinásť=13; štrnásť=14; pätnásť=15;
      šestnásť=16; sedemnásť=17; osemnásť=18; devätnásť=19; dvadsať=20; tridsať=30;
      štyridsať=40; päťdesiat=50; šesťdesiat=60; sedemdesiat=70; osemdesiat=80;
      deväťdesiat=90; sto=100*; tisíc=1000^; milión=1e6^; milióny miliónov=1e6^!;
      miliarda=1e9^; miliardy miliárd=1e9^!`,
    glue: true
  },
  hr: {
    words: `jedan jedna jedno jednog jednoj=1; dva dvije dvaju=2; tri triju=3; četiri=4; pet=5;
      šest=6; sedam=7; osam=8; devet=9; deset=10; jedanaest=11; dvanaest=12; trinaest=13;
      četrnaest=14; petnaest=15; šesnaest=16; sedamnaest=17; osamnaest=18; devetnaest=19;
      dvadeset=20; trideset=30; četrdeset=40; pedeset=50; šezdeset=60; sedamdeset=70;
      osamdeset=80; devedeset=90; sto=100*; dvjesto dvesta=200; tristo=300; četiristo=400;
      petsto=500; šeststo=600; sedamsto=700; osamsto=800; devetsto=900;
      tisuću tisuća tisuće hiljadu hiljada hiljade=1000^; milijun milijuna milion miliona=1e6^;
      milijarda milijarde milijardi=1e9^`,
    conn: { i: 'down' }, glue: true
  },
  sl: {
    words: `en ena eno enega eni=1; dva dve dveh=2; tri treh=3; štiri štirih=4; pet petih=5;
      šest šestih=6; sedem sedmih=7; osem osmih=8; devet devetih=9; deset desetih=10;
      enajst=11; dvanajst=12; trinajst=13; štirinajst=14; petnajst=15; šestnajst=16;
      sedemnajst=17; osemnajst=18; devetnajst=19; dvajset=20; trideset=30; štirideset=40;
      petdeset=50; šestdeset=60; sedemdeset=70; osemdeset=80; devetdeset=90; sto=100*;
      tisoč=1000^; milijon=1e6^; milijona milijonov=1e6^!; milijarda=1e9^;
      milijarde milijard=1e9^!`,
    conn: { in: 'unit' }, glue: true
  },
  lt: {
    words: `vienas viena vieno vienos vienam vienai vieną=1; du dvi dviejų dviem=2; trys trijų trims=3;
      keturi keturios keturių=4; penki penkios penkių=5; šeši šešios šešių=6;
      septyni septynios septynių=7; aštuoni aštuonios aštuonių=8; devyni devynios devynių=9;
      dešimt dešimties=10; vienuolika=11; dvylika=12; trylika=13; keturiolika=14;
      penkiolika=15; šešiolika=16; septyniolika=17; aštuoniolika=18; devyniolika=19;
      dvidešimt=20; trisdešimt=30; keturiasdešimt=40; penkiasdešimt=50; šešiasdešimt=60;
      septyniasdešimt=70; aštuoniasdešimt=80; devyniasdešimt=90; šimtas=100*;
      šimtai šimtų šimtą=100*!; tūkstantis=1000^; tūkstančiai tūkstančių tūkstantį=1000^!;
      milijonas=1e6^; milijonai milijonų=1e6^!; milijardas=1e9^; milijardai milijardų=1e9^!`
  },
  el: {
    words: `ενα ενας μια μιας ενος=1; δυο=2; τρια τρεις τριων=3; τεσσερα τεσσερις τεσσαρων=4;
      πεντε=5; εξι=6; επτα εφτα=7; οκτω οχτω=8; εννεα εννια=9; δεκα=10; εντεκα ενδεκα=11;
      δωδεκα=12; δεκατρια δεκατρεις=13; δεκατεσσερα δεκατεσσερις=14; δεκαπεντε=15;
      δεκαεξι δεκαξι=16; δεκαεπτα δεκαεφτα=17; δεκαοκτω δεκαοχτω=18; δεκαεννεα δεκαεννια=19;
      εικοσι=20; τριαντα=30; σαραντα=40; πενηντα=50; εξηντα=60; εβδομηντα=70; ογδοντα=80;
      ενενηντα=90; εκατο εκατον=100*; διακοσια διακοσιοι διακοσιες διακοσιων=200;
      τριακοσια τριακοσιοι τριακοσιες=300; τετρακοσια τετρακοσιοι τετρακοσιες=400;
      πεντακοσια πεντακοσιοι πεντακοσιες=500; εξακοσια εξακοσιοι εξακοσιες=600;
      επτακοσια εφτακοσια επτακοσιοι επτακοσιες=700; οκτακοσια οχτακοσια οκτακοσιοι οκτακοσιες=800;
      εννιακοσια εννεακοσια εννιακοσιοι εννιακοσιες=900; χιλια χιλιοι χιλιες=1000^;
      χιλιαδες χιλιαδων=1000^!; εκατομμυριο=1e6^; εκατομμυρια εκατομμυριων=1e6^!;
      δισεκατομμυριο=1e9^; δισεκατομμυρια=1e9^!`,
    flat: true, tenUnit: true
  },
  tr: {
    words: `bir=1; iki=2; üç=3; dört=4; beş=5; altı=6; yedi=7; sekiz=8; dokuz=9; on=10; yirmi=20;
      otuz=30; kırk=40; elli=50; altmış=60; yetmiş=70; seksen=80; doksan=90; yüz=100*;
      bin=1000^; milyon=1e6^; milyar=1e9^`,
    // «bir yüz» — «одно лицо», а не сто: сотню и тысячу турок единицей не
    // предваряет.
    noOne: ['yüz', 'bin'], glue: true, tenUnit: true,
    ordinal: /^(birinci|ikinci|üçüncü|dördüncü|beşinci|altıncı|yedinci|sekizinci|dokuzuncu|onuncu|yirminci|otuzuncu|kırkıncı|ellinci|altmışıncı|yetmişinci|sekseninci|doksanıncı|yüzüncü|bininci)$/u
  },
  hu: {
    words: `egy=1; kettő két=2; három=3; négy=4; öt=5; hat=6; hét=7; nyolc=8; kilenc=9; tíz=10;
      húsz=20; harminc=30; negyven=40; ötven=50; hatvan=60; hetven=70; nyolcvan=80;
      kilencven=90; száz=100*; ezer=1000^; millió=1e6^; milliárd=1e9^`,
    pieces: 'tizen=10; huszon=20', glue: true
  },
  fi: {
    words: `yksi=1; kaksi=2; kolme=3; neljä=4; viisi=5; kuusi=6; seitsemän=7; kahdeksan=8;
      yhdeksän=9; kymmenen=10; toista=10+; kymmentä=10*!; sata=100*; sataa=100*!;
      tuhat=1000^; tuhatta=1000^!; miljoona=1e6^; miljoonaa=1e6^!; miljardi=1e9^;
      miljardia=1e9^!`,
    glue: true
  },
  he: {
    words: `אחד אחת=1; שניים שתיים שני שתי שתים=2; שלושה שלוש שלושת שלש=3; ארבעה ארבע ארבעת=4;
      חמישה חמש חמשת=5; שישה שש ששת=6; שבעה שבע שבעת=7; שמונה שמונת=8; תשעה תשע תשעת=9;
      עשרה עשר=10+; עשרת=10; עשרים=20; שלושים=30; ארבעים=40; חמישים=50; שישים=60;
      שבעים=70; שמונים=80; תשעים=90; מאה=100*; מאות=100*!; מאתיים=200; אלף=1000^;
      אלפים=1000^!; אלפיים=1000^2; מיליון=1e6^; מיליונים=1e6^!; מיליארד=1e9^`,
    conn: { 'ו': 'down' }, glue: true
  },
  ar: {
    words: `واحد واحده احد احدي=1; اثنان اثنين اثنتان اثنتين اثنا اثني اثنتا اثنتي=2; ثلاثه ثلاث=3;
      اربعه اربع=4; خمسه خمس=5; سته ست=6; سبعه سبع=7; ثمانيه ثماني ثمان=8; تسعه تسع=9;
      عشره عشر=10+; عشرون عشرين=20; ثلاثون ثلاثين=30; اربعون اربعين=40; خمسون خمسين=50;
      ستون ستين=60; سبعون سبعين=70; ثمانون ثمانين=80; تسعون تسعين=90; مئه مائه=100*;
      مئتان مئتين مائتان مائتين=200; الف=1000^; الفان الفين=1000^2; الاف=1000^!;
      مليون=1e6^; ملايين=1e6^!; مليار=1e9^; مليارات=1e9^!`,
    conn: { 'و': 'and' }, glue: true
  },
  hi: {
    words: `एक=1; दो=2; तीन=3; चार=4; पाँच पांच=5; छह छः छे=6; सात=7; आठ=8; नौ=9; दस=10;
      ग्यारह=11; बारह=12; तेरह=13; चौदह=14; पंद्रह पन्द्रह=15; सोलह=16; सत्रह=17; अठारह=18;
      उन्नीस=19; बीस=20; इक्कीस=21; बाईस=22; तेईस=23; चौबीस=24; पच्चीस=25; छब्बीस=26;
      सत्ताईस=27; अट्ठाईस अठ्ठाईस अठाईस=28; उनतीस उन्तीस=29; तीस=30; इकतीस इकत्तीस=31;
      बत्तीस=32; तैंतीस तेंतीस=33; चौंतीस=34; पैंतीस=35; छत्तीस=36; सैंतीस=37; अड़तीस=38;
      उनतालीस उनचालीस=39; चालीस=40; इकतालीस=41; बयालीस=42; तैंतालीस=43; चौवालीस चवालीस=44;
      पैंतालीस=45; छियालीस=46; सैंतालीस=47; अड़तालीस=48; उनचास=49; पचास=50; इक्यावन=51;
      बावन=52; तिरेपन तिरपन=53; चौवन चव्वन=54; पचपन=55; छप्पन=56; सत्तावन=57;
      अट्ठावन अठावन=58; उनसठ=59; साठ=60; इकसठ=61; बासठ=62; तिरसठ=63; चौंसठ=64; पैंसठ=65;
      छियासठ=66; सड़सठ सरसठ=67; अड़सठ=68; उनहत्तर=69; सत्तर=70; इकहत्तर=71; बहत्तर=72;
      तिहत्तर=73; चौहत्तर=74; पचहत्तर=75; छिहत्तर=76; सतहत्तर=77; अठहत्तर=78;
      उन्यासी उनासी=79; अस्सी=80; इक्यासी=81; बयासी=82; तिरासी=83; चौरासी=84; पचासी=85;
      छियासी=86; सत्तासी=87; अट्ठासी=88; नवासी=89; नब्बे=90; इक्यानवे=91; बानवे=92;
      तिरानवे=93; चौरानवे=94; पंचानवे=95; छियानवे=96; सत्तानवे=97; अट्ठानवे=98;
      निन्यानवे=99; सौ=100*; हज़ार हजार=1000^; लाख=1e5^; करोड़ करोड=1e7^; अरब=1e9^`,
    atomic: true
  },
  vi: {
    words: `một=1; hai=2; ba=3; bốn=4; tư=4~; năm=5-; lăm nhăm=5~; sáu=6; bảy bẩy=7; tám=8; chín=9;
      mười=10; mươi=10*!; mốt=1~; trăm=100*; nghìn ngàn=1000^; triệu=1e6^; tỷ tỉ=1e9^`,
    conn: { linh: 'zero', 'lẻ': 'zero' }, tenUnit: true
  },
  // Языки без пробелов: число режется прямо из строки (см. unspaced).
  th: {
    words: `หนึ่ง=1; สอง=2; สาม=3; สี่=4; ห้า=5; หก=6; เจ็ด=7; แปด=8; เก้า=9; ยี่=2?; เอ็ด=1~;
      สิบ=10*; ร้อย=100*; พัน=1000*; หมื่น=1e4*; แสน=1e5*; ล้าน=1e6^`,
    unspaced: true, minWords: 2
  },
  ja: {
    words: `〇 零=0; 一=1; 二=2; 三=3; 四=4; 五=5; 六=6; 七=7; 八=8; 九=9; 十=10*; 百=100*; 千=1000*;
      万 萬=1e4^; 億=1e8^; 兆=1e12^`,
    unspaced: true, cjk: true, loneMin: 2,
    counters: '年月日歳才人回個つ本枚匹頭冊台件分秒時度倍円位階番歩割杯軒曲点名社週代部号ヶカケか'
  },
  zh: {
    words: `〇 零=0; 一=1; 二 两 兩=2; 三=3; 四=4; 五=5; 六=6; 七=7; 八=8; 九=9; 十=10*; 百=100*;
      千=1000*; 万 萬=1e4^; 亿 億=1e8^; 兆=1e12^`,
    unspaced: true, cjk: true,
    counters: '年月日岁歲号號个個人次元块塊分秒点點度倍位层層名本张張件条條天周週代届'
  },
  ko: {
    words: `영 공=0; 일=1; 이=2; 삼=3; 사=4; 오=5; 육=6; 칠=7; 팔=8; 구=9; 십=10*; 백=100*; 천=1000*;
      만=1e4^; 억=1e8^; 조=1e12^`,
    korean: true
  }
};

// Корейский: число стоит слитно со счётным словом и частицей — «삼십오년에».
// Хвост слова должен быть ими целиком, иначе «오십시오» («заходите») стало бы
// «50시오».
const KO_COUNTERS = ['년', '월', '일', '살', '세', '시', '분', '초', '개', '명', '번', '원', '층',
  '대', '권', '장', '마리', '잔', '병', '주', '시간', '개월', '주년', '년간', '일간', '위', '회', '차',
  '배', '도', '퍼센트', '프로', '미터', '킬로', '달러', '센트', '부', '호', '등', '점', '쪽', '인분'];
const KO_PARTICLES = ['에서', '에게', '까지', '부터', '으로', '이나', '정도', '은', '는', '이', '가',
  '을', '를', '의', '에', '도', '만', '로', '와', '과', '쯤', '나', '씩', '째', '도'];

// ── разбор ────────────────────────────────────────────────────────────────

const cache = new Map();

/** Словарь языка в удобном для разбора виде (строится один раз). */
function lexicon(lang) {
  if (cache.has(lang)) return cache.get(lang);
  const src = LEX[lang];
  let L = null;
  if (src) {
    const parse = (spec, piece = false) => {
      const map = new Map();
      for (const part of (spec || '').split(';')) {
        const m = part.trim().match(/^(.+)=([\d.e]+)([*^!+~\-?2]*)$/);
        if (!m) continue;
        const f = m[3];
        const e = {
          v: Number(m[2]),
          k: f.includes('*') ? 'mult' : f.includes('^') ? 'scale' : f.includes('+') ? 'teen' : 'add',
          bound: f.includes('!'), tail: f.includes('~'), notTens: f.includes('-'),
          weak: f.includes('?'), times: f.includes('2') ? 2 : 1, piece
        };
        // «עשר», «عشر», «toista» — и самостоятельное десять, и «-надцать».
        if (e.k === 'teen') e.alone = !['toista'].includes(m[1].trim());
        for (const w of m[1].trim().split(/\s+/)) map.set(norm(w, lang), { ...e, word: w });
      }
      return map;
    };
    L = {
      lang, ...src,
      words: parse(src.words),
      pieces: parse(src.pieces, true),
      conn: new Map(Object.entries(src.conn || {}).map(([w, r]) => [norm(w, lang), r])),
      loneMin: src.loneMin || 10,
      decimal: new Set((src.decimal || []).map(w => norm(w, lang))),
      glued: new Map()
    };
  }
  cache.set(lang, L);
  return L;
}

/** Слово для поиска в словаре: регистр, апострофы, огласовки, где они мешают. */
function norm(w, lang) {
  let s = String(w).normalize('NFC').replace(/[’ʼ`]/g, "'");
  s = lang === 'tr' ? s.toLocaleLowerCase('tr') : s.toLowerCase();
  if (lang === 'ro' || lang === 'el') s = s.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
  if (lang === 'he') s = s.replace(/[֑-ׇ]/g, '');
  if (lang === 'ar') {
    s = s.replace(/[ً-ْٰـ]/g, '').replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  }
  return s;
}

const START = Object.freeze({
  total: 0, lastScale: Infinity, grp: 0, place: Infinity, seg: 0, room: Infinity,
  prevRoom: Infinity, lastAdd: 0, tens: false, weak: false, big: null
});

/** Младший занятый разряд: 30 → 10, 35 → 1, 300 → 100. */
function low(n) {
  if (!n) return Infinity;
  let p = 1;
  while (n % (p * 10) === 0) p *= 10;
  return p;
}

/** Один шаг числа. Новое состояние или null, если слово числа не продолжает. */
function step(s, e, L) {
  const n = { ...s, weak: !!e.weak };
  if (e.k === 'teen') {
    // «viisi|toista», «שלוש עשרה»: единица перед ним одна и стоит последней.
    if (s.seg >= 1 && s.seg <= 9 && s.lastAdd === s.seg) {
      n.seg += 10; n.grp += 10; n.room = 1; n.tens = false; n.lastAdd = 10;
      return n;
    }
    if (!e.alone) return null;
    e = { ...e, k: 'add' };
  }
  if (e.k === 'add') {
    if (e.tail && !s.tens) return null;
    if (e.notTens && s.tens) return null;
    if (e.v >= s.room) {
      // Французские 70–79 и 90–99: «soixante-dix», «quatre-vingt-onze».
      const fr = L.teenAfter && L.teenAfter.includes(s.seg) && s.seg === s.grp % 100
        && e.v >= 10 && e.v < 20;
      if (!fr) return null;
    }
    n.prevRoom = s.room; n.lastAdd = e.v;
    n.seg += e.v; n.grp += e.v; n.room = low(n.seg);
    if (e.v === 0) n.room = s.room;
    // «zehn fünf» — не пятнадцать: 11–19 у большинства языков свои слова.
    // Исключения — где «десять» и правда берёт единицу: «dix-sept», «on bir»,
    // «mười lăm», «δέκα τρία»; у хинди своё слово на каждое число до ста.
    if ((e.v === 10 && !e.piece && !L.tenUnit) || (L.atomic && e.v < 100)) n.room = 1;
    n.tens = e.v === 10;
    return n;
  }
  if (e.k === 'mult') {
    if (e.bound && !s.seg) return null;
    if (!s.seg && s.grp) return null;
    if (L.noOne && L.noOne.includes(e.word) && s.seg === 1 && s.grp === 1) return null;
    const base = s.seg || 1;
    if (e.v >= s.place || base >= e.v || base * e.v >= s.place) return null;
    n.grp = s.grp - s.seg + base * e.v;
    n.place = e.v; n.seg = 0; n.room = e.v; n.lastAdd = 0; n.tens = e.v === 10;
    return n;
  }
  // Шкала: закрывает группу. «mil millones» — тысяча миллионов, поэтому
  // шкала больше прежней умножает всё набранное.
  if (L.noOne && L.noOne.includes(e.word) && s.grp === 1 && !s.total) return null;
  if (s.grp) {
    const g = s.grp * e.times;
    if (e.v >= s.lastScale || g >= e.v) return null;
    n.total = s.total + g * e.v;
  } else if (s.total) {
    if (e.v <= s.lastScale || s.total >= e.v) return null;
    n.total = s.total * e.v;
  } else {
    if (e.bound) return null;
    n.total = e.times * e.v;
  }
  n.lastScale = e.v; n.grp = 0; n.seg = 0; n.place = Infinity; n.room = e.v;
  n.lastAdd = 0; n.tens = false;
  if (!n.big || e.v >= n.big.v) n.big = { v: e.v, word: e.word };
  return n;
}

/** Союз внутри числа: «treinta y cinco», «fünf und dreißig», «cento e vinte». */
function join(s, rule, e, L) {
  if (!s.grp && !s.total) return null;
  const unit = s.lastAdd >= 1 && s.lastAdd <= 9 && s.seg % 10 === s.lastAdd && e.k === 'add'
    && e.v >= 20 && e.v < 100 && e.v % 10 === 0;
  const afterMult = !s.seg && (s.grp || s.total);
  if (rule === 'unit' || ((rule === 'og' || rule === 'and') && unit)) {
    // Единица впереди, десятки после: «fünf und dreißig» = 35.
    if (!unit || e.v >= s.prevRoom) return null;
    return { ...s, seg: s.seg + e.v, grp: s.grp + e.v, room: 1, lastAdd: e.v, tens: false,
      units: false };
  }
  if (rule === 'after' || rule === 'og') return afterMult ? step(s, e, L) : null;
  if (rule === 'tens') {
    // «treinta y cinco», «douăzeci și cinci»: только между десятками и единицей.
    const t = s.seg % 100;
    if (!(t >= 20 && t % 10 === 0 && e.k === 'add' && e.v < 10)) return null;
    return step(s, e, L);
  }
  if (rule === 'big') return e.k === 'mult' || e.k === 'scale' ? step(s, e, L) : null;
  if (rule === 'zero') return afterMult ? step(s, e, L) : null;
  // down / and: что угодно, что число продолжает, — кроме «десять и пять».
  if (s.seg === 10 || (s.seg && s.seg < 10 && s.seg === s.grp && !s.total)) return null;
  return step(s, e, L);
}

/** Прогнать по числу цепочку кусков (кусок — слово словаря или союз). */
function feed(s, items, L) {
  for (let i = 0; i < items.length && s; i++) {
    const it = items[i];
    if (it.conn) {
      const next = items[i + 1];
      if (!next || next.conn) return null;
      s = join(s, it.conn, next, L);
      i++;
    } else s = step(s, it, L);
  }
  return s;
}

/**
 * Слитное слово → куски: «fünfunddreißig» → fünf|und|dreißig, «kolmekymmentä»
 * → kolme|kymmentä. Режем на наименьшее число кусков, и слово годится, только
 * если куски складываются в одно число целиком.
 */
function glue(key, L) {
  if (L.glued.has(key)) return L.glued.get(key);
  const piece = (w) => L.words.get(w) || L.pieces.get(w) || (L.conn.has(w) ? { conn: L.conn.get(w) } : null);
  const len = key.length;
  const best = new Array(len + 1).fill(null);
  best[0] = [];
  for (let i = 0; i < len; i++) {
    if (!best[i]) continue;
    for (let j = len; j > i; j--) {
      const p = piece(key.slice(i, j));
      if (!p) continue;
      const cand = [...best[i], p];
      if (!best[j] || cand.length < best[j].length) best[j] = cand;
    }
  }
  let out = best[len];
  if (out) {
    // «וחמש», «وثلاثون»: союз-приставка, за ним число.
    const body = out[0].conn ? out.slice(1) : out;
    const r = body.length && feed(START, body, L);
    if (out.length < 2 || !r || r.weak) out = null;
  }
  if (L.glued.size > 2000) L.glued.clear();
  L.glued.set(key, out);
  return out;
}

/** Слово → куски числа или null. */
function classify(word, L) {
  const key = norm(word, L.lang);
  const e = L.words.get(key);
  if (e) return [e];
  return L.glue ? glue(key, L) : null;
}

const fmtCache = new Map();
function fmt(v, lang) {
  let f = fmtCache.get(lang);
  if (!f) {
    try { f = new Intl.NumberFormat(lang, { useGrouping: 'min2', numberingSystem: 'latn', maximumFractionDigits: 0 }); }
    catch (e) { f = new Intl.NumberFormat('en', { useGrouping: 'min2', maximumFractionDigits: 0 }); }
    fmtCache.set(lang, f);
  }
  return f.format(v);
}

/** Значение числа цифрами: «5 Milliarden», «3万5000», «2.300.000». */
function show(s, L, gap = ' ') {
  const v = s.total + s.grp;
  if (L.cjk || L.korean) {
    // Японский и китайский пишут большие числа по шкалам: 3万5000, 1億2000万.
    const units = L.korean ? [[1e12, '조'], [1e8, '억'], [1e4, '만']]
      : [[1e12, '兆'], [1e8, L.lang === 'zh' ? '亿' : '億'], [1e4, '万']];
    let rest = v, out = '';
    for (const [u, ch] of units) if (rest >= u) { out += fmt(Math.floor(rest / u), 'en') + ch; rest %= u; }
    return out + (rest || !out ? String(rest) : '');
  }
  if (s.big && s.big.v >= 1e5 && v % s.big.v === 0 && v / s.big.v < 1e6) {
    return `${fmt(v / s.big.v, L.lang)}${gap}${s.big.surface || s.big.word}`;
  }
  return fmt(v, L.lang);
}

const WORD = /([\p{L}\p{M}]+(?:['’ʼ][\p{L}\p{M}]+)*)/u;
/** Между словами одного числа — только пробел или дефис. */
const soft = (gap) => /^(\s+|\s*[-‐‑]\s*)$/.test(gap);

/** Языки с пробелами. */
function spaced(text, L, open) {
  const parts = text.split(WORD);
  const words = [], gaps = [parts[0]];
  for (let i = 1; i < parts.length; i += 2) { words.push(parts[i]); gaps.push(parts[i + 1]); }
  const n = words.length;
  const out = [gaps[0]];

  /** Самое длинное число с позиции i. */
  const longest = (i) => {
    let s = START, best = null, j = i, count = 0, first = null;
    const isWeak = (items) => items.length === 1 && items[0].weak;
    while (j < n) {
      if (j > i && !soft(gaps[j])) break;
      const key = norm(words[j], L.lang);
      // «quatre vingt(s)» — одно число из двух слов.
      if (L.phrases && j + 1 < n && soft(gaps[j + 1])) {
        const v = L.phrases[`${key} ${norm(words[j + 1], L.lang)}`];
        if (v) {
          const s2 = step(s, { k: 'add', v }, L);
          if (s2) { s = s2; j += 2; count++; best = { end: j, s, count, first: null }; continue; }
        }
      }
      if (j > i && L.conn.has(key) && j + 1 < n && soft(gaps[j + 1])) {
        const next = classify(words[j + 1], L);
        const s2 = next && feed(s, [{ conn: L.conn.get(key) }, ...next], L);
        if (!s2) break;
        s = s2; j += 2; count++;
        if (!s.weak) best = { end: j, s, count, first };
        continue;
      }
      const items = classify(words[j], L);
      if (!items || (j === i && items[0].conn)) break;
      let s2 = feed(s, items, L);
      if (!s2 && L.years && count === 1 && (s.grp === 19 || s.grp === 20) && !s.total) {
        // «nineteen ninety», «twenty twenty-four» — год, а не два числа.
        const y = longest2(j);
        if (y) return { start: i, end: y.end, s: { ...START, grp: s.grp * 100 + y.v }, count: 2, first: null };
      }
      if (!s2) break;
      if (s2.big && s2.big.word === items[items.length - 1].word) s2.big = { ...s2.big, surface: words[j] };
      // «a hundred», «o sută» — то же одинокое «сто»: в счёт слов не идёт.
      if (isWeak(items)) { s = s2; j++; continue; }
      if (!count) first = items.length === 1 ? items[0] : null;
      s = s2; j++; count++;
      if (!s.weak) best = { end: j, s, count, first };
    }
    return best && { ...best, start: i };
  };
  // Вторая половина года: 10–99 одним или двумя словами.
  const longest2 = (i) => {
    let s = START, best = null;
    for (let j = i; j < n && j < i + 2; j++) {
      if (j > i && !soft(gaps[j])) break;
      const items = classify(words[j], L);
      const s2 = items && feed(s, items, L);
      if (!s2 || s2.total || s2.place < Infinity) break;
      s = s2;
      if (s.grp >= 10 && s.grp < 100) best = { end: j + 1, v: s.grp };
    }
    return best;
  };

  const accept = (r) => {
    const v = r.s.total + r.s.grp;
    if (r.count === 1 && r.first) {
      // Одинокое «עשר», «عشر» — чаще хвост порядкового («التاسع عشر»).
      if (r.first.k !== 'add') return false;
      if (v < L.loneMin) return false;
    }
    if (r.count === 1 && !r.first && v < 10) return false;
    if (L.minWords && r.count < L.minWords) return false;
    // «eine Million», «один миллион», «a million» — словами, как в эталонах.
    if (r.s.big && r.s.big.v >= 1e6 && v === r.s.big.v) return false;
    // Дробь: «two point five million» — «two point 5 million» хуже слов.
    const dec = (k) => k >= 0 && k < n && L.decimal.has(norm(words[k], L.lang));
    if ((dec(r.start - 1) && soft(gaps[r.start])) || (dec(r.end) && soft(gaps[r.end]))) return false;
    // Порядковое следом: «двадцать пятый», «vingt et unième».
    let k = r.end;
    if (k < n && L.conn.has(norm(words[k], L.lang)) && soft(gaps[k])) k++;
    if (L.ordinal && k < n && soft(gaps[k]) && L.ordinal.test(norm(words[k], L.lang))) return false;
    // Хвост открытой строки ещё растёт: «fünf und» может стать «fünf und dreißig».
    if (open && /^\s*$/.test(gaps[n])) {
      let rest = r.end;
      while (rest < n && L.conn.has(norm(words[rest], L.lang))) rest++;
      if (rest === n) return false;
    }
    return true;
  };

  for (let i = 0; i < n;) {
    const r = longest(i);
    if (r && accept(r)) {
      out.push(show(r.s, L), gaps[r.end]);
      i = r.end;
    } else {
      out.push(words[i], gaps[i + 1]);
      i++;
    }
  }
  return out.join('');
}

/** Японский, китайский, тайский: границ слов нет, число режем из строки. */
function unspaced(text, L, open) {
  const seg = new Intl.Segmenter(L.lang, { granularity: 'word' });
  const bounds = new Set([0, text.length]);
  for (const x of seg.segment(text)) { bounds.add(x.index); bounds.add(x.index + x.segment.length); }
  // Кусок словаря с позиции i: самый длинный.
  let maxLen = 1;
  for (const w of L.words.keys()) maxLen = Math.max(maxLen, w.length);
  const at = (i) => {
    for (let k = Math.min(maxLen, text.length - i); k > 0; k--) {
      const e = L.words.get(text.slice(i, i + k));
      if (e) return { e, len: k };
    }
    return null;
  };
  const isNum = (i) => i < text.length && !!at(i);
  const counter = (i) => L.counters && i < text.length && L.counters.includes(text[i]);

  let out = '', i = 0;
  while (i < text.length) {
    // Число начинается на границе слова и не посреди другого числа:
    // «劇団四季», «三日月», «เก้าอี้» — слова, а не числа.
    if (!bounds.has(i) || !isNum(i) || (i > 0 && isNum(i - 1))) { out += text[i]; i++; continue; }
    let s = START, alive = true, j = i, count = 0, best = null, digitsOnly = '';
    while (j < text.length) {
      const q = at(j);
      if (!q) break;
      // «二〇二四» — год цифра за цифрой, числом он не разбирается.
      digitsOnly = digitsOnly !== null && q.e.k === 'add' && q.e.v < 10 ? digitsOnly + q.e.v : null;
      if (alive) {
        const s2 = q.e.v === 0 && s.place < Infinity && !s.seg ? s : step(s, q.e, L);
        if (s2) s = s2; else alive = false;
      }
      if (!alive && digitsOnly === null) break;
      j += q.len; count++;
      // Конец числа — граница слова, или (ja, zh) счётное слово, которым
      // слово и кончается: «三つ|の», но не «三日月».
      const edge = bounds.has(j) || (L.cjk && counter(j) && bounds.has(j + 1));
      if (edge && !isNum(j)) {
        if (digitsOnly && count >= 3) best = { end: j, text: digitsOnly, count };
        else if (alive && !s.weak) best = { end: j, s, count };
      }
    }
    const ok = best && (() => {
      if (best.text) return true;
      const v = best.s.total + best.s.grp;
      const head = at(i).e;
      if (L.cjk && head.k !== 'add' && head.v !== 10) return false;  // 千万, 百万, 万一
      if (L.minWords && best.count < L.minWords) return false;
      if (best.count === 1) {
        if (head.k !== 'add' || v < L.loneMin || v === 1) return false;
        if (L.cjk && !counter(best.end)) return false;
      }
      if (open && /^\s*$/.test(text.slice(best.end))) return false;
      return true;
    })();
    if (ok) {
      out += best.text || show(best.s, L);
      i = best.end;
    } else { out += text[i]; i++; }
  }
  return out;
}

/** Корейский: сино-корейские числа слитно со счётным словом и частицей. */
function korean(text, L, open) {
  return text.replace(/[가-힣]+/g, (tok, at) => {
    if (open && at + tok.length === text.trimEnd().length) return tok;
    let s = START, best = null;
    for (let j = 0; j < tok.length; j++) {
      const e = L.words.get(tok[j]);
      if (!e) break;
      const s2 = e.v === 0 && s.place < Infinity && !s.seg ? s : step(s, e, L);
      if (!s2) break;
      s = s2;
      if (j >= 1) best = { end: j + 1, s };
    }
    if (!best) return tok;
    const head = L.words.get(tok[0]);
    // «백», «천», «만» впереди — не число («만» — «только»); «오만» — «гордыня»,
    // «이만» — «на этом», поэтому единица со шкалой без множителя тоже нет.
    if (head.k !== 'add' && head.v !== 10) return tok;
    if (best.end === 2 && L.words.get(tok[1]).k === 'scale') return tok;
    let rest = tok.slice(best.end);
    for (let changed = true; changed && rest;) {
      changed = false;
      for (const p of KO_PARTICLES) {
        if (rest.length > p.length && rest.endsWith(p)) { rest = rest.slice(0, -p.length); changed = true; break; }
        if (rest === p) { rest = ''; changed = true; break; }
      }
    }
    if (rest && !KO_COUNTERS.includes(rest)) return tok;
    return show(best.s, L) + tok.slice(best.end);
  });
}

/**
 * Числа в строке — цифрами.
 * @param text строка распознавания
 * @param lang код языка речи (en, de, zh…); неизвестный язык строку не трогает
 * @param open строка ещё растёт: хвостовое число оставить словами
 */
export function digits(text, lang, { open = false } = {}) {
  if (!text || !lang) return text;
  const L = lexicon(String(lang).toLowerCase().split(/[-_]/)[0]);
  if (!L) return text;
  if (L.korean) return korean(text, L, open);
  if (L.unspaced) return unspaced(text, L, open);
  return spaced(text, L, open);
}

/** Языки, для которых есть словарь. */
export const NUMERAL_LANGS = Object.keys(LEX);
