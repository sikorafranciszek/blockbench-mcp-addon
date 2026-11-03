# Blockbench MCP w ChatGPT przez ngrok

[English version](chatgpt-ngrok.md)

ChatGPT działa w chmurze i łączy się tylko z serwerami w internecie, a serwer wtyczki nasłuchuje wyłącznie na Twoim komputerze. Połączy je tunel [ngrok](https://ngrok.com/), a wszystko, co trzeba skopiować, znajdziesz w Blockbench w `Tools > MCP Server`.

> [!WARNING]
> **Tunel udostępnia serwer w internecie.** Przechodzą tylko żądania z Twoim tajnym kluczem, ale każdy, kto ma pełny adres, może sterować Blockbench oraz czytać i zapisywać pliki w każdym miejscu dostępnym dla Blockbench. Traktuj ten adres jak hasło, a po skończonej pracy zamknij tunel.

> [!NOTE]
> Darmowy plan ngrok i klucz wtyczki przetestowano z oficjalnym klientem MCP. Samego połączenia z ChatGPT jeszcze nie sprawdzono. Jeśli któryś krok działa inaczej, [zgłoś to](https://github.com/sikorafranciszek/blockbench-mcp-addon/issues).

## Czego potrzebujesz

- Blockbench z wtyczką w wersji 1.1 lub nowszej. Zobacz [szybki start](../README.pl.md#szybki-start).
- Darmowe [konto ngrok](https://dashboard.ngrok.com/signup).
- ChatGPT w przeglądarce, na koncie z możliwością dodawania własnych serwerów MCP. Dokumentacja OpenAI nie wymienia planów i zaznacza, że obowiązują zasady obszaru roboczego, więc na koncie firmowym może to wymagać zgody administratora.

## 1. Zainstaluj ngrok

Zainstaluj ngrok ze [sklepu Microsoft Store](https://apps.microsoft.com/detail/9MVS1J51GMK6) albo ze [strony pobierania ngrok](https://ngrok.com/download). Następnie dodaj token z [panelu ngrok](https://dashboard.ngrok.com/get-started/your-authtoken):

```bash
ngrok config add-authtoken TWOJ_TOKEN
```

Wystarczy zrobić to raz.

## 2. Uruchom tunel

Otwórz w Blockbench `Tools > MCP Server`. Przy **ChatGPT, step 1** wybierz **Copy**, a potem wklej i uruchom polecenie w terminalu:

```bash
ngrok http 127.0.0.1:3939
```

Nie zamykaj tego terminala. Nie dodawaj `--host-header` ani polityki przepisującej nagłówek `Host`, bo osłabiłoby to ochronę wtyczki.

## 3. Skopiuj adres

Wróć do okna `MCP Server` i wybierz **Refresh**. Opis przy **ChatGPT, step 2** powinien teraz zawierać `tunnel found`, a adres Twoją domenę ngrok i klucz:

```text
https://TWOJA-DOMENA/mcp?key=TWOJ_KLUCZ
```

Wybierz **Copy** obok niego. Wtyczka tworzy klucz przy pierwszym otwarciu tego okna i go zapamiętuje. Gdy działa inny agent ngrok, wtyczka może nie znaleźć adresu. Wtedy zastąp `YOUR-NGROK-DOMAIN` domeną z wiersza `Forwarding` w terminalu.

## 4. Dodaj serwer do ChatGPT

1. Otwórz [chatgpt.com/plugins](https://chatgpt.com/plugins).
2. Wybierz przycisk plusa, a potem **Add custom MCP server**.
3. Wpisz nazwę, np. `Blockbench`.
4. W sekcji **Connection** wklej jako adres serwera adres z kroku 3.
5. W **Authentication** wybierz **No authentication**. Tę rolę pełni klucz w adresie.
6. Przeczytaj ostrzeżenie o ryzyku i wybierz **I understand and want to continue**.
7. Wybierz **Create as a plugin**, sprawdź, czy narzędzia się pojawiły, i zainstaluj wtyczkę.

OpenAI co jakiś czas zmienia te menu. Aktualne kroki znajdziesz w poradniku [dodawania własnego serwera MCP](https://developers.openai.com/api/docs/guides/custom-mcp-server).

## 5. Korzystaj

Blockbench i tunel muszą pozostać włączone. Rozpocznij nową rozmowę, wpisz `@`, wybierz swoją wtyczkę i o coś poproś:

> Zrób w Blockbench małą latarnię w stylu Minecrafta, w formacie java_block. Sprawdzaj podgląd po każdym etapie.

ChatGPT prosi o potwierdzenie każdego narzędzia, które coś zmienia. Narzędzia tylko do odczytu, np. podglądy, nie pytają. W ramach jednej rozmowy możesz zapamiętać decyzję dla danego narzędzia.

Dokumentacja OpenAI nie mówi, jak ChatGPT traktuje obrazy zwracane przez narzędzia. Jeśli ChatGPT nie reaguje na podglądy, sprawdzaj jego pracę na żywo w Blockbench i mów mu, co poprawić.

## Gdy skończysz

Naciśnij `Ctrl+C` w terminalu z ngrok, aby zamknąć tunel. Gdy tunel jest zamknięty, ChatGPT nie ma dostępu do Blockbench.

Darmowa domena ngrok się nie zmienia, więc adres w ChatGPT zadziała także przy kolejnym uruchomieniu tunelu.

## Bezpieczeństwo

- Jeśli adres wycieknie, wybierz **New key** w oknie `MCP Server`, a potem zaktualizuj adres w ChatGPT. Stary klucz od razu przestaje działać.
- Ustawienie `MCP: Allow run_script` pozostaw **wyłączone**. Po jego włączeniu wyciek adresu pozwoliłby innym uruchamiać kod na Twoim komputerze, a okno `MCP Server` pokazuje wtedy ostrzeżenie.
- Zamykaj tunel, gdy z niego nie korzystasz.
- Czytaj każde potwierdzenie przed zatwierdzeniem, zwłaszcza dla narzędzi zapisujących lub eksportujących pliki. Strona lub plik, który czyta ChatGPT, może próbować nakłonić go do ich niewłaściwego użycia.
- Nigdy nie umieszczaj tego adresu na zrzutach ekranu, w repozytorium ani na publicznym czacie. Może go też pokazać np. podgląd żądań ngrok pod `http://127.0.0.1:4040`.

## Rozwiązywanie problemów

| Problem | Co zrobić |
| --- | --- |
| W oknie `MCP Server` nie ma przycisku **New key** | Wtyczka jest nieaktualna albo nie została przeładowana. Zaktualizuj plik i uruchom Blockbench ponownie. |
| Żądania zwracają **403** | Klucza brakuje albo jest błędny. Skopiuj adres z okna `MCP Server` jeszcze raz. |
| ngrok zgłasza błąd połączenia z serwerem lub zwraca 502 | Blockbench jest zamknięty albo wtyczka nie działa. Sprawdź `Tools > MCP Server`. |
| ngrok zgłasza, że punkt końcowy już działa (`ERR_NGROK_334`) | Tunel już jest uruchomiony. Darmowy plan ma jedną domenę, więc najpierw zamknij drugi tunel. |
| ChatGPT dostaje stronę ostrzeżenia ngrok (`ERR_NGROK_6024`) | Darmowe konta pokazują ją przeglądarkom. Nie powinna wpływać na ruch API, a jeśli jednak wpływa, usuwa ją płatny plan ngrok. |
| ChatGPT nie pokazuje nowych narzędzi | Po aktualizacji wtyczki otwórz jej szczegóły w ChatGPT i odśwież ją. |
| Tunel przestaje działać | Darmowy plan ngrok ma [miesięczne limity](https://ngrok.com/docs/pricing-limits/free-plan-limits). Limit transferu najszybciej zużywają obrazy. |
