# Ti2A.dev

Сайт студии. Два раздела: **Под заказ** и **Open-source**. Статический,
собирается одним файлом, публикуется на GitHub Pages при каждом пуше в `main`.

Русская версия - `index.html`, английская - `index.en.html`.

## Как добавить работу

Всё редактируется в [`data/site.yaml`](data/site.yaml).

**Под заказ** - скопировать блок в списке `client`:

```yaml
- id: new-thing
  title: Короткое название
  year: "2026"
  status: shipped        # shipped | ongoing | paused
  client: Имя заказчика  # убрать строку, если согласия на имя нет
  tags: [TypeScript, PostgreSQL]
  ru:
    summary: Что это было, одним-двумя предложениями.
    result: Что изменилось в итоге.
  en:
    summary: The same, in English.
    result: What changed.
```

Имя заказчика и скриншот - только с его согласия. Без согласия блок
остаётся обезличенным: задача, стек, результат. Скриншот кладётся в
`assets/` и подключается строкой `image: file.png`.

**Open-source** - одна строка, описание подтянется само:

```yaml
- repo: devochkaskustikom/some-repo
  npm: some-package   # необязательно, добавит ссылку и версию с npm
  site: https://…     # необязательно, живое демо
```

При сборке GitHub отдаёт описание, язык, звёзды, лицензию и дату
последнего пуша, npm - версию пакета. Свои поля в блоке перекрывают
полученные. Ответ кэшируется в `data/.cache.json`, поэтому сборка
проходит и без сети.

## Команды

```bash
node build.mjs            # собрать dist/
node build.mjs --watch    # пересобирать при правке yaml или css
node build.mjs --no-fetch # собрать только из кэша, без GitHub и npm
```

Зависимостей нет, нужен Node 18+.

## Публикация

Пуш в `main` запускает `.github/workflows/pages.yml`, который собирает
`dist/` и выкладывает его на GitHub Pages. `dist/CNAME` указывает на `ti2a.ru`.

Свой домен: в DNS `ti2a.ru` добавить запись

```
CNAME  devochkaskustikom.github.io
```

и в настройках репозитория → Pages → Custom domain указать `ti2a.ru`.
Сертификат GitHub выпустит сам. Пока запись не сменена, сайт открывается
по адресу `https://devochkaskustikom.github.io/ti2a/`.
