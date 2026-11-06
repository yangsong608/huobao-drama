import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REQ = os.path.join(os.path.dirname(HERE), "requirements-admin.txt")


class RequirementsCase(unittest.TestCase):
    def test_form_parsing_dependency_declared(self):
        with open(REQ, encoding="utf-8") as fh:
            names = {
                line.split("==", 1)[0].strip().lower()
                for line in fh
                if line.strip() and not line.lstrip().startswith("#")
            }
        self.assertIn("python-multipart", names)


if __name__ == "__main__":
    unittest.main()
