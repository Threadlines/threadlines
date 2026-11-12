// Source of the .so files beside it (see README.md): what node-pty does,
// in miniature, built unchanged on two Ubuntu releases.
#include <pty.h>
#include <termios.h>
#include <cmath>
#include <thread>

extern "C" int open_terminal(double x) {
  int primary = 0;
  int secondary = 0;
  struct termios settings {};
  cfsetospeed(&settings, B9600);
  std::thread([] {}).join();
  return openpty(&primary, &secondary, nullptr, &settings, nullptr) + static_cast<int>(std::pow(x, 1.5));
}
